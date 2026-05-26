/**
 * GpuScheduler — module 05's real scheduling/lease logic over a MOCKED inventory.
 *
 * "GPUs faked, decisions real": inventory counts and lease feasibility come from
 * module 13 (`buildInventory` / `leaseFeasibility`); everything else — GPU-class
 * selection, priority queueing, budget gating, CPU degradation, time-bounded
 * leases, teardown bookkeeping and usage emission — is real here.
 *
 * It implements the engine's `ComputeClient` port (`inventory()` +
 * `leaseFeasibility()`) so it is a drop-in for the mock backend's compute side,
 * and layers a richer lease lifecycle (`requestLease` / `release` / `reap`) on top
 * for the real run path.
 */
import type {
  AuthContext,
  BudgetPolicy,
  ComputeRequest,
  Event,
  GpuInventory,
  UsageEvent,
  WorkerLease,
} from "@gentech/contracts";
import { WorkerLeaseSchema } from "@gentech/contracts";
import type { ComputeClient, LeaseDecision } from "@gentech/engine";
import { priorityFor } from "@gentech/iam";
import { checkBudget } from "@gentech/cost";
import { buildInventory, leaseFeasibility, getScenario, type Scenario } from "@gentech/mock-server";
import { LeaseRegistry, PriorityQueue } from "./queue.js";
import { emitLeaseGranted, recordUsage, type EmitFn } from "./usage.js";

/** GPU classes ordered weakest → strongest. Degradation walks this leftward. */
const CLASS_ORDER = ["none", "small", "medium", "large"] as const;
type GpuClass = (typeof CLASS_ORDER)[number];

/** Per-class default VRAM the mock workers advertise (CPU = 0). */
const CLASS_VRAM_GB: Record<GpuClass, number> = { none: 0, small: 8, medium: 16, large: 40 };

/** Default lease TTL — overridable per request via `estDurationSec`. */
const DEFAULT_LEASE_SEC = 60;

export interface GpuSchedulerOptions {
  /** Mock-server scenario id supplying GpuInventory + feasibility (FR / §9). */
  scenarioId: string;
  /** Deterministic seed for the mock inventory RNG. */
  seed?: string | number;
  /** Monotonic clock in ms (SimClock-friendly); defaults to Date.now. */
  now?: () => number;
  /** Injected event sink (control-plane bus). No-op if omitted. */
  emit?: EmitFn;
}

/** Result of a scheduling decision: a grant (possibly degraded), or queued. */
export interface LeaseGrant {
  granted: boolean;
  lease?: WorkerLease;
  /** True when we leased a lighter class than requested (scarcity/budget). */
  degraded: boolean;
  requestedClass: GpuClass;
  grantedClass?: GpuClass;
  reason?: string;
}

export interface RequestContext {
  auth: AuthContext;
  jobId: string;
  nodeId?: string;
  traceId?: string;
  budget?: BudgetPolicy;
  /** Estimated credits for the budget gate; defaults to a per-class heuristic. */
  estCredits?: number;
}

export class GpuScheduler implements ComputeClient {
  private readonly scenario: Scenario;
  private readonly seed: string | number;
  private readonly nowMs: () => number;
  private readonly emit: EmitFn;
  private readonly queue = new PriorityQueue();
  private readonly leases = new LeaseRegistry();

  constructor(opts: GpuSchedulerOptions) {
    this.scenario = getScenario(opts.scenarioId);
    this.seed = opts.seed ?? "scheduler";
    this.nowMs = opts.now ?? (() => Date.now());
    this.emit = opts.emit ?? (() => {});
  }

  // ── ComputeClient port (drop-in for the engine) ───────────────────────────

  /** Current `GpuInventory` from the mock, debited by leases we already hold. */
  async inventory(): Promise<GpuInventory> {
    return this.liveInventory();
  }

  /**
   * Engine-port feasibility check. Mirrors mock-server semantics but degrades to
   * a lighter class / CPU rather than reporting `grantable:false`, so the engine
   * always gets a runnable target (the "never fail, degrade" boundary).
   */
  async leaseFeasibility(req: ComputeRequest): Promise<LeaseDecision> {
    const inv = this.liveInventory();
    const { decision } = this.decide(req, inv);
    return decision;
  }

  // ── Richer scheduling lifecycle (real run path) ───────────────────────────

  /**
   * Decide + grant a time-bounded lease for `req`. Resolves priority from the
   * principal (iam), gates on budget (cost), checks feasibility against live
   * inventory (mock 13), and degrades the GPU class under scarcity / over-budget
   * instead of failing. Always returns a grant (worst case a CPU lease).
   */
  requestLease(req: ComputeRequest, ctx: RequestContext): LeaseGrant {
    const priority = priorityFor(ctx.auth);
    const traceId = ctx.traceId ?? `trace_${ctx.jobId}`;

    // Record demand in the queue (FR-4) — enables fair ordering + aging snapshots.
    this.queue.enqueue({
      jobId: ctx.jobId,
      nodeId: ctx.nodeId,
      tenantId: ctx.auth.tenantId,
      req: { ...req, priority },
      priority,
      enqueuedAtMs: this.nowMs(),
    });

    const inv = this.liveInventory();
    const requestedClass = (req.gpuClass ?? "none") as GpuClass;
    const { decision, degraded, reason } = this.decide({ ...req, priority }, inv, ctx);

    // Dequeue the request we just queued (it's the one being serviced now).
    this.queue.dequeue(this.nowMs());

    if (!decision.grantable) {
      // Only reachable if budget denies even CPU — surface as a non-grant.
      return { granted: false, degraded, requestedClass, reason: decision.reason ?? reason };
    }

    const lease = this.grant(decision, ctx, req);
    return {
      granted: true,
      lease,
      degraded,
      requestedClass,
      grantedClass: decision.gpuClass as GpuClass,
      reason,
    };
  }

  /** Release a lease, meter its usage, and reclaim capacity (teardown). */
  release(leaseId: string, opts: { tenantId: string; traceId?: string } = { tenantId: "" }): UsageEvent | undefined {
    const lease = this.leases.release(leaseId);
    if (!lease) return undefined;
    const releasedAtIso = this.iso(this.nowMs());
    return recordUsage(this.emit, {
      lease,
      tenantId: opts.tenantId || lease.jobId,
      traceId: opts.traceId ?? `trace_${lease.jobId}`,
      releasedAtIso,
    });
  }

  /**
   * Expiry sweep (FR-6): reclaim leases whose `expiresAt` <= now, metering each.
   * `now` is ms (SimClock-friendly). Returns the usage events for reaped leases.
   */
  reap(nowMsOverride?: number): UsageEvent[] {
    const nowIso = this.iso(nowMsOverride ?? this.nowMs());
    const reaped = this.leases.reap(nowIso);
    return reaped.map((lease) =>
      recordUsage(this.emit, {
        lease,
        tenantId: lease.jobId, // tenant unknown at reap; jobId stands in (host re-tags)
        traceId: `trace_${lease.jobId}`,
        releasedAtIso: nowIso,
      }),
    );
  }

  /** Active (un-released, un-reaped) leases — inspection/tests. */
  activeLeases(): WorkerLease[] {
    return this.leases.all();
  }

  /** Pending queue snapshot (highest effective priority first). */
  pending() {
    return this.queue.snapshot(this.nowMs());
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Inventory from the mock, with our held leases debited from `available`. */
  private liveInventory(): GpuInventory {
    const base = buildInventory(
      this.scenario,
      this.nowMs() / 1000,
      this.seed,
      this.leases.activeCount,
      this.queue.size,
    );
    const inUse = this.leases.inUseByClass();
    const available: Record<string, number> = { ...base.available };
    for (const [cls, n] of Object.entries(inUse)) {
      if (cls === "none") continue;
      available[cls] = Math.max(0, (available[cls] ?? 0) - n);
    }
    return { ...base, available };
  }

  /**
   * Core decision: pick the best grantable class at or below the requested class,
   * subject to budget. Walks CLASS_ORDER down from the request; returns the first
   * class that is both feasible (mock 13) and within budget (cost 11). Falls back
   * to CPU (`none`) which the mock always grants — unless budget denies even that.
   */
  private decide(
    req: ComputeRequest,
    inv: GpuInventory,
    ctx?: RequestContext,
  ): { decision: LeaseDecision; degraded: boolean; reason?: string } {
    const requested = (req.gpuClass ?? "none") as GpuClass;
    const startIdx = CLASS_ORDER.indexOf(requested);
    let reason: string | undefined;

    for (let i = startIdx; i >= 0; i--) {
      const cls = CLASS_ORDER[i] as GpuClass;

      // Budget gate (FR-4/FR-5): deprioritize/deny over-budget tenants.
      const est = this.estCreditsFor(cls, req, ctx);
      const budgetDecision = checkBudget(est, ctx?.budget);
      if (!budgetDecision.allow) {
        reason = budgetDecision.reason;
        continue; // try a cheaper class
      }

      // Feasibility against live inventory (mock 13).
      const feas = leaseFeasibility({ ...req, gpuClass: cls }, inv);
      if (feas.grantable) {
        const decision: LeaseDecision = {
          grantable: true,
          gpuClass: feas.gpuClass,
          ...(feas.endpoint ? { endpoint: feas.endpoint } : {}),
        };
        return { decision, degraded: cls !== requested, reason: cls !== requested ? reason ?? feas.reason : undefined };
      }
      reason = feas.reason;
    }

    // Could not satisfy any class within budget — even CPU was budget-denied.
    return {
      decision: { grantable: false, gpuClass: "none", reason: reason ?? "no compute within budget" },
      degraded: requested !== "none",
      reason,
    };
  }

  /** Heuristic per-class credit estimate for the budget gate (cost 11 prices real). */
  private estCreditsFor(cls: GpuClass, req: ComputeRequest, ctx?: RequestContext): number {
    if (ctx?.estCredits !== undefined) {
      // Scale the caller's estimate by relative class weight.
      const weight: Record<GpuClass, number> = { none: 0.1, small: 1, medium: 2, large: 4 };
      return Math.ceil(ctx.estCredits * weight[cls]);
    }
    const dur = req.estDurationSec ?? DEFAULT_LEASE_SEC;
    const rate: Record<GpuClass, number> = { none: 1, small: 5, medium: 12, large: 30 };
    return Math.ceil((dur / 60) * rate[cls]);
  }

  /** Mint a time-bounded WorkerLease, register it, and emit lease.granted. */
  private grant(decision: LeaseDecision, ctx: RequestContext, req: ComputeRequest): WorkerLease {
    const cls = decision.gpuClass as GpuClass;
    const grantedMs = this.nowMs();
    const ttlSec = req.estDurationSec && req.estDurationSec > 0 ? req.estDurationSec : DEFAULT_LEASE_SEC;
    const lease: WorkerLease = WorkerLeaseSchema.parse({
      leaseId: this.newLeaseId(),
      jobId: ctx.jobId,
      ...(ctx.nodeId ? { nodeId: ctx.nodeId } : {}),
      gpuClass: cls,
      vramGb: Math.max(CLASS_VRAM_GB[cls], req.minVramGb ?? 0),
      cpuOnly: cls === "none",
      grantedAt: this.iso(grantedMs),
      expiresAt: this.iso(grantedMs + ttlSec * 1000),
      ...(decision.endpoint ? { endpoint: decision.endpoint } : {}),
    });
    this.leases.add(lease);
    emitLeaseGranted(this.emit, lease, ctx.auth.tenantId, ctx.traceId ?? `trace_${ctx.jobId}`);
    return lease;
  }

  private leaseSeq = 0;
  private newLeaseId(): string {
    return `lease_${(++this.leaseSeq).toString(36).padStart(4, "0")}`;
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }
}
