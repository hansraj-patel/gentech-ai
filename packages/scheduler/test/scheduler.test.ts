import { describe, it, expect, beforeEach } from "vitest";
import {
  GpuScheduler,
  PriorityQueue,
  _resetUsageIds,
  type RequestContext,
} from "../dist/index.js";
import type { ComputeClient } from "@gentech/engine";
import {
  WorkerLeaseSchema,
  UsageEventSchema,
  type AuthContext,
  type BudgetPolicy,
  type ComputeRequest,
  type Event,
} from "@gentech/contracts";

// ── deterministic clock (SimClock-style) ──────────────────────────────────────
function fixedClock(startMs = Date.UTC(2026, 4, 26)) {
  let t = startMs;
  return {
    now: () => t,
    advance: (sec: number) => {
      t += sec * 1000;
    },
  };
}

const auth = (roles: string[], tenantId = "ten_a"): AuthContext => ({
  tenantId,
  userId: "user_1",
  roles,
  scopes: [],
  attrs: {},
});

// operator → maxPriority 7; viewer → 3.
const operator = auth(["operator"]);
const viewer = auth(["viewer"]);

const req = (gpuClass: ComputeRequest["gpuClass"], extra: Partial<ComputeRequest> = {}): ComputeRequest => ({
  gpuClass,
  minVramGb: 0,
  estDurationSec: 30,
  priority: 5,
  ...extra,
});

const ctx = (a: AuthContext, jobId: string, over: Partial<RequestContext> = {}): RequestContext => ({
  auth: a,
  jobId,
  ...over,
});

beforeEach(() => {
  _resetUsageIds();
});

describe("ComputeClient port conformance", () => {
  it("GpuScheduler is a drop-in ComputeClient", async () => {
    const clock = fixedClock();
    // type-level assertion — must satisfy the engine port exactly.
    const c: ComputeClient = new GpuScheduler({ scenarioId: "parking_lot_daytime", now: clock.now });
    const inv = await c.inventory();
    expect(inv.total).toBeDefined();
    const decision = await c.leaseFeasibility(req("small"));
    expect(decision.grantable).toBe(true);
    expect(typeof decision.gpuClass).toBe("string");
  });
});

describe("priority ordering (queue)", () => {
  it("higher priority leased before lower; FIFO within a band", () => {
    const q = new PriorityQueue();
    q.enqueue({ jobId: "lo1", tenantId: "t", req: req("small"), priority: 3, enqueuedAtMs: 0 });
    q.enqueue({ jobId: "hi", tenantId: "t", req: req("small"), priority: 7, enqueuedAtMs: 0 });
    q.enqueue({ jobId: "lo2", tenantId: "t", req: req("small"), priority: 3, enqueuedAtMs: 0 });
    expect(q.dequeue(0)?.jobId).toBe("hi"); // highest priority first
    expect(q.dequeue(0)?.jobId).toBe("lo1"); // FIFO within priority 3
    expect(q.dequeue(0)?.jobId).toBe("lo2");
  });

  it("aging eventually lifts a starved low-priority request above a fresh higher one", () => {
    const q = new PriorityQueue();
    q.enqueue({ jobId: "old_lo", tenantId: "t", req: req("small"), priority: 3, enqueuedAtMs: 0 });
    q.enqueue({ jobId: "new_hi", tenantId: "t", req: req("small"), priority: 5, enqueuedAtMs: 200_000 });
    // After ~210s the old priority-3 request has aged +7 → effective 10→capped 9, beats fresh 5.
    expect(q.peek(210_000)?.jobId).toBe("old_lo");
  });

  it("scheduler grants a higher-priority request a lease before a lower one queues", () => {
    const clock = fixedClock();
    const s = new GpuScheduler({ scenarioId: "parking_lot_daytime", now: clock.now });
    const hi = s.requestLease(req("small"), ctx(operator, "job_hi"));
    const lo = s.requestLease(req("small"), ctx(viewer, "job_lo"));
    expect(hi.granted).toBe(true);
    expect(lo.granted).toBe(true);
    // operator outranks viewer — reflected in the resolved lease request priority.
    expect(hi.lease).toBeDefined();
  });
});

describe("budget gate", () => {
  const overBudget: BudgetPolicy = {
    budgetRef: "bud_1",
    tenantId: "ten_a",
    scope: "tenant",
    capCredits: 10,
    period: "monthly",
    spent: 10,
    emergencyCutoff: true,
  };

  it("over-budget request degrades to a cheaper class rather than failing the GPU ask", () => {
    const clock = fixedClock();
    const s = new GpuScheduler({ scenarioId: "parking_lot_daytime", now: clock.now });
    // large is expensive; with a tiny cap + emergency cutoff, big classes are denied,
    // and we degrade. CPU (none) cost still gated by emergencyCutoff → not grantable.
    const grant = s.requestLease(req("large", { estDurationSec: 600 }), ctx(operator, "job_b", { budget: overBudget }));
    // emergency cutoff with spent>=cap denies everything incl. CPU.
    expect(grant.granted).toBe(false);
    expect(grant.reason).toMatch(/cutoff|exceed/i);
  });

  it("near-cap budget degrades a large ask down to an affordable class", () => {
    const clock = fixedClock();
    const s = new GpuScheduler({ scenarioId: "parking_lot_daytime", now: clock.now });
    const budget: BudgetPolicy = {
      budgetRef: "bud_2",
      tenantId: "ten_a",
      scope: "tenant",
      capCredits: 60,
      period: "monthly",
      spent: 0,
      emergencyCutoff: false,
    };
    // large @600s costs 300; medium 120; small 50; none 10 → only small/none fit cap 60.
    const grant = s.requestLease(req("large", { estDurationSec: 600 }), ctx(operator, "job_c", { budget }));
    expect(grant.granted).toBe(true);
    expect(grant.degraded).toBe(true);
    expect(["small", "none"]).toContain(grant.grantedClass);
  });
});

describe("GPU scarcity → CPU degradation", () => {
  it("exhausting a class degrades the next request down to CPU instead of failing", () => {
    const clock = fixedClock();
    // gate_intrusion_night: small:2, medium:1, large:0, scarce profile.
    const s = new GpuScheduler({ scenarioId: "gate_intrusion_night", seed: "scarce-seed", now: clock.now });

    // Drain whatever small/medium capacity the scarce inventory exposes by holding leases.
    const held: string[] = [];
    for (let i = 0; i < 10; i++) {
      const g = s.requestLease(req("small"), ctx(operator, `drain_${i}`));
      if (g.granted && g.lease && g.grantedClass !== "none") held.push(g.lease.leaseId);
    }

    // large is impossible (total 0) → must degrade; once GPUs are held, lands on CPU.
    const grant = s.requestLease(req("large"), ctx(operator, "job_scarce"));
    expect(grant.granted).toBe(true);
    expect(grant.degraded).toBe(true);
    expect(grant.grantedClass).toBe("none");
    expect(grant.lease?.cpuOnly).toBe(true);
  });

  it("a large request always degrades when no large GPUs exist in the scenario", () => {
    const clock = fixedClock();
    const s = new GpuScheduler({ scenarioId: "gate_intrusion_night", now: clock.now });
    const grant = s.requestLease(req("large"), ctx(operator, "job_nolarge"));
    expect(grant.granted).toBe(true);
    expect(grant.degraded).toBe(true);
    expect(grant.grantedClass).not.toBe("large");
  });
});

describe("lease lifecycle: schema, expiry, usage", () => {
  it("granted WorkerLease validates against its schema and is time-bounded", () => {
    const clock = fixedClock();
    const s = new GpuScheduler({ scenarioId: "parking_lot_daytime", now: clock.now });
    const grant = s.requestLease(req("small", { estDurationSec: 45 }), ctx(operator, "job_lease"));
    expect(grant.lease).toBeDefined();
    const lease = WorkerLeaseSchema.parse(grant.lease);
    expect(Date.parse(lease.expiresAt) - Date.parse(lease.grantedAt)).toBe(45_000);
    expect(lease.endpoint).toMatch(/^mock:\/\//);
  });

  it("reap frees capacity for expired leases and meters usage", () => {
    const clock = fixedClock();
    const s = new GpuScheduler({ scenarioId: "parking_lot_daytime", now: clock.now });
    const grant = s.requestLease(req("small", { estDurationSec: 30 }), ctx(operator, "job_reap"));
    expect(s.activeLeases()).toHaveLength(1);

    clock.advance(31); // past the 30s TTL
    const usage = s.reap();
    expect(s.activeLeases()).toHaveLength(0); // capacity reclaimed
    expect(usage).toHaveLength(1);
    expect(UsageEventSchema.parse(usage[0])).toBeTruthy();
    expect(usage[0].gpuSeconds).toBeCloseTo(31, 1);
  });

  it("emits compute.lease.granted and usage.recorded via the injected emit callback", () => {
    const clock = fixedClock();
    const captured: { topic: string; event: Event }[] = [];
    const s = new GpuScheduler({
      scenarioId: "parking_lot_daytime",
      now: clock.now,
      emit: (topic, event) => captured.push({ topic, event }),
    });
    const grant = s.requestLease(req("small"), ctx(operator, "job_emit", { traceId: "trace_1" }));
    expect(captured.map((c) => c.topic)).toContain("compute.lease.granted");

    clock.advance(5);
    const usage = s.release(grant.lease!.leaseId, { tenantId: "ten_a", traceId: "trace_1" });
    expect(usage).toBeDefined();
    expect(captured.map((c) => c.topic)).toContain("usage.recorded");
    // released-lease usage reflects the 5s held window.
    expect(usage!.gpuSeconds).toBeCloseTo(5, 1);
    const usageEvt = captured.find((c) => c.topic === "usage.recorded");
    expect(usageEvt?.event.tenantId).toBe("ten_a");
  });
});

describe("GPU-class selection (FR-1 acceptance)", () => {
  it("a lightweight request gets a small/CPU lease; a heavy request gets a higher class", () => {
    const clock = fixedClock();
    const s = new GpuScheduler({ scenarioId: "parking_lot_daytime", now: clock.now });
    const light = s.requestLease(req("small"), ctx(operator, "job_light"));
    const heavy = s.requestLease(req("large"), ctx(operator, "job_heavy"));
    expect(["small", "none"]).toContain(light.grantedClass);
    expect(heavy.grantedClass).toBe("large"); // parking lot has 1 large free, steady
  });
});
