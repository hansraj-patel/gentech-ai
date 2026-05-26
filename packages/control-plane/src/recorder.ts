/**
 * Telemetry collector (module 12, FR-6). Subscribes to the bus and indexes the
 * observability stream by `traceId` AND `tenantId`. All reads are
 * tenant-scoped: a caller from tenant B can never read tenant A's spans,
 * decisions, results or job status even when it knows the exact id — the
 * tenant is part of every index key, so a mismatched tenant simply misses.
 */
import type {
  DecisionLog,
  Event,
  JobStatus,
  ResultEvent,
  TraceSpan,
} from "@gentech/contracts";
import { TOPICS } from "@gentech/contracts";
import type { InProcessEventBus, Unsubscribe } from "./bus.js";

/** Compose a tenant-scoped index key so a foreign tenant can never collide. */
const key = (tenantId: string, id: string): string => `${tenantId}::${id}`;

/**
 * Subscribes to `trace.span`, `decision.logged`, `result.event` and
 * `job.status.changed`, building tenant-scoped indexes. Pure read methods
 * below; nothing leaks across tenants.
 */
export class Recorder {
  /** (tenantId, traceId) -> spans */
  private readonly spans = new Map<string, TraceSpan[]>();
  /** (tenantId, traceId) -> decisions */
  private readonly decisions = new Map<string, DecisionLog[]>();
  /** (tenantId, jobId) -> results */
  private readonly results = new Map<string, ResultEvent[]>();
  /** (tenantId, jobId) -> latest job status */
  private readonly jobs = new Map<string, JobStatus>();

  private readonly subscriptions: Unsubscribe[] = [];

  constructor(bus: InProcessEventBus) {
    this.subscriptions.push(
      bus.subscribe(TOPICS.traceSpan, (e) => this.onTraceSpan(e)),
      bus.subscribe(TOPICS.decisionLogged, (e) => this.onDecision(e)),
      bus.subscribe(TOPICS.resultEvent, (e) => this.onResult(e)),
      bus.subscribe(TOPICS.jobStatusChanged, (e) => this.onJobStatus(e)),
    );
  }

  /** Detach from the bus (idempotent). */
  close(): void {
    for (const off of this.subscriptions.splice(0)) off();
  }

  // ── tenant-scoped reads ──────────────────────────────────────────────────
  spansFor(tenantId: string, traceId: string): TraceSpan[] {
    return [...(this.spans.get(key(tenantId, traceId)) ?? [])];
  }

  decisionsFor(tenantId: string, traceId: string): DecisionLog[] {
    return [...(this.decisions.get(key(tenantId, traceId)) ?? [])];
  }

  resultsFor(tenantId: string, jobId: string): ResultEvent[] {
    return [...(this.results.get(key(tenantId, jobId)) ?? [])];
  }

  jobStatus(tenantId: string, jobId: string): JobStatus | undefined {
    return this.jobs.get(key(tenantId, jobId));
  }

  // ── ingestion ────────────────────────────────────────────────────────────
  private onTraceSpan(e: Event): void {
    const span = e.payload as TraceSpan;
    push(this.spans, key(e.tenantId, span.traceId), span);
  }

  private onDecision(e: Event): void {
    const log = e.payload as DecisionLog;
    push(this.decisions, key(e.tenantId, log.traceId), log);
  }

  private onResult(e: Event): void {
    const result = e.payload as ResultEvent;
    push(this.results, key(result.tenantId, result.jobId), result);
  }

  private onJobStatus(e: Event): void {
    const status = e.payload as JobStatus;
    this.jobs.set(key(status.tenantId, status.jobId), status);
  }
}

function push<T>(map: Map<string, T[]>, k: string, value: T): void {
  const list = map.get(k);
  if (list) list.push(value);
  else map.set(k, [value]);
}
