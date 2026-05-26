/**
 * PipelineEngine (module 04) — runs a real PipelineSpec DAG against pluggable
 * inference/compute backends (the mock today, real 05/06 later). It honors
 * dependency edges, fans segments across nodes, acquires leases (degrading to CPU
 * under GPU scarcity rather than failing), retries + dead-letters failing nodes
 * without losing prior results, emits progressive partial ResultEvents as segments
 * arrive, and meters usage — all on the canonical event topics (§8).
 */
import type {
  AuthContext,
  Event,
  JobStatus,
  MediaSegment,
  PipelineNode,
  PipelineSpec,
  ResultEvent,
  UsageEvent,
  WorkerLease,
} from "@gentech/contracts";
import { aggregate } from "./aggregate.js";
import { newEventId, newJobId, newLeaseId, newRequestId, newTraceId } from "./ids.js";
import { JobTracker } from "./job.js";
import { CheckpointStore, CircuitBreaker, withRetry } from "./reliability.js";
import { topoLevels } from "./scheduler.js";
import { buildUsage } from "./usage.js";
import { InMemoryEventSink, type EngineClients, type EventSink, type LeaseDecision } from "./ports.js";

export interface EngineOptions {
  now?: () => string;
  baseBackoffMs?: number;
  breakerThreshold?: number;
}

export interface RunOptions {
  traceId?: string;
  /** Abort mid-run → job transitions to `cancelled` (FR-8). */
  signal?: AbortSignal;
}

export interface RunResult {
  job: JobStatus;
  results: ResultEvent[];
  usage: UsageEvent[];
  sink: EventSink;
}

const CREDITS_PER_GPU_SECOND = 5;

export class PipelineEngine {
  private readonly now: () => string;
  private readonly baseBackoffMs: number;
  private readonly breakerThreshold: number;

  constructor(opts: EngineOptions = {}) {
    this.now = opts.now ?? (() => new Date().toISOString());
    this.baseBackoffMs = opts.baseBackoffMs ?? 2;
    this.breakerThreshold = opts.breakerThreshold ?? 1;
  }

  async run(
    spec: PipelineSpec,
    segments: MediaSegment[],
    auth: AuthContext,
    clients: EngineClients,
    runOpts: RunOptions = {},
  ): Promise<RunResult> {
    const sink = clients.sink ?? new InMemoryEventSink();
    const traceId = runOpts.traceId ?? newTraceId();
    const jobId = newJobId();
    const tenantId = spec.tenantId;
    const emit = (topic: string, payload: unknown, kind = topic): void =>
      sink.emit(topic, this.event(kind, tenantId, traceId, payload, jobId));

    const levels = topoLevels(spec); // throws on a cyclic/dangling spec
    const totalUnits = spec.nodes.length * Math.max(1, segments.length);
    const job = new JobTracker(jobId, spec, totalUnits, this.now);
    const checkpoint = new CheckpointStore();
    const breaker = new CircuitBreaker(this.breakerThreshold);
    const leases = new Map<string, LeaseDecision>();
    const usage: UsageEvent[] = [];
    const results: ResultEvent[] = [];

    job.start();
    emit("job.status.changed", job.snapshot());

    const ensureLease = async (node: PipelineNode): Promise<LeaseDecision> => {
      const cached = leases.get(node.nodeId);
      if (cached) return cached;
      let decision = await clients.compute.leaseFeasibility(node.compute);
      if (!decision.grantable) {
        // graceful degradation (FR-6): fall back to a CPU-only lease instead of failing
        decision = await clients.compute.leaseFeasibility({ ...node.compute, gpuClass: "none" });
        job.degrade();
      }
      leases.set(node.nodeId, decision);
      return decision;
    };

    const runNodeSegment = async (node: PipelineNode, seg: MediaSegment): Promise<void> => {
      if (breaker.isOpen(node.nodeId)) {
        // don't downgrade a node that already terminally failed (keep it "failed")
        if (job.nodeState(node.nodeId) !== "failed") job.setNode(node.nodeId, "skipped");
        return;
      }
      if (checkpoint.has(node.nodeId, seg.segmentId)) {
        job.unitDone(); // partial recovery: already completed, don't redo
        return;
      }
      const lease = await ensureLease(node);
      job.setNode(node.nodeId, "running");
      const req = {
        requestId: newRequestId(),
        jobId,
        nodeId: node.nodeId,
        modelId: node.modelId,
        segment: { segmentId: seg.segmentId, storageRef: seg.storageRef },
        params: { ...node.params, task: node.task },
      };

      try {
        const res = await withRetry(() => clients.inference.infer(req), spec.retryPolicy, {
          baseMs: this.baseBackoffMs,
          onRetry: (attempt, err) =>
            emit("trace.span", this.span(traceId, node, seg, { event: "retry", attempt, err: errMsg(err) }), "trace.span"),
        });
        checkpoint.put(node.nodeId, seg.segmentId, res);
        job.unitDone();

        const gpuSeconds = (res.latencyMs ?? 0) / 1000;
        job.addCost(gpuSeconds * CREDITS_PER_GPU_SECOND);
        const u = buildUsage({ tenantId, jobId, gpuClass: lease.gpuClass, gpuSeconds, now: this.now });
        usage.push(u);
        emit("usage.recorded", u);
        emit("trace.span", this.span(traceId, node, seg, { event: "infer", latencyMs: res.latencyMs }), "trace.span");
      } catch (err) {
        // retries exhausted → dead-letter, trip the breaker, but keep prior results
        job.setNode(node.nodeId, "failed");
        breaker.recordFailure(node.nodeId);
        emit(
          "dlq.failed",
          {
            code: "NODE_INFERENCE_FAILED",
            module: "engine",
            message: `node ${node.nodeId} failed after ${spec.retryPolicy.maxRetries} retries`,
            retryable: false,
            details: { nodeId: node.nodeId, segmentId: seg.segmentId, error: errMsg(err) },
          },
          "dlq.failed",
        );
      }
    };

    // ── segment-major execution: simulate progressive arrival ───────────────────
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]!;
      if (runOpts.signal?.aborted) {
        job.cancel();
        emit("job.status.changed", job.snapshot());
        return { job: job.snapshot(), results, usage, sink };
      }
      // within a segment, run dependency levels in order; nodes in a level concurrently
      for (const level of levels) {
        await Promise.all(level.map((node) => runNodeSegment(node, seg)));
      }
      const isLast = i === segments.length - 1 || seg.final;
      for (const r of aggregate({ spec, responses: checkpoint.all(), jobId, tenantId, partial: !isLast, now: this.now })) {
        results.push(r);
        emit("result.event", r, "result.event");
      }
      emit("job.status.changed", job.snapshot());
    }

    // every node that ran without failing/skipping is done
    for (const n of spec.nodes) {
      const states = job.snapshot().nodeStates;
      if (states[n.nodeId] === "running" || states[n.nodeId] === "pending") job.setNode(n.nodeId, "done");
    }
    job.finish();
    emit("job.status.changed", job.snapshot());

    return { job: job.snapshot(), results, usage, sink };
  }

  private event(type: string, tenantId: string, traceId: string, payload: unknown, jobId?: string): Event {
    return {
      eventId: newEventId(),
      type,
      tenantId,
      ...(jobId ? { jobId } : {}),
      ts: this.now(),
      traceId,
      payload,
    };
  }

  private span(traceId: string, node: PipelineNode, seg: MediaSegment, attrs: Record<string, unknown>) {
    return {
      traceId,
      spanId: newRequestId().replace("req_", "span_"),
      module: "engine",
      name: attrs.event === "retry" ? "infer.retry" : "infer",
      startedAt: this.now(),
      durationMs: typeof attrs.latencyMs === "number" ? attrs.latencyMs : 0,
      attrs: { nodeId: node.nodeId, task: node.task, modelId: node.modelId, segmentId: seg.segmentId, ...attrs },
    };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Build a WorkerLease from a lease decision (for callers/tests that want the typed grant). */
export function leaseFromDecision(jobId: string, nodeId: string, decision: LeaseDecision, now: () => string): WorkerLease {
  const grantedAt = now();
  return {
    leaseId: newLeaseId(),
    jobId,
    nodeId,
    gpuClass: decision.gpuClass,
    vramGb: decision.gpuClass === "none" ? 0 : 8,
    cpuOnly: decision.gpuClass === "none",
    grantedAt,
    expiresAt: grantedAt,
    ...(decision.endpoint ? { endpoint: decision.endpoint } : {}),
  };
}
