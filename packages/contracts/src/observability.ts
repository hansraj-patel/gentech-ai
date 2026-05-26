/**
 * Observability & control-plane contracts — module 12 / the §7-§8 cross-cutting
 * types every module emits or consumes: distributed-trace spans, decision logs,
 * health/circuit state, degradation policies, and the canonical set of
 * event-bus topic names.
 *
 * As everywhere in this package, zod is the single source of truth and TS types
 * are inferred via z.infer. `Timestamp` is reused from `schemas.ts` rather than
 * redefined so the whole package shares one RFC-3339 definition.
 */
import { z } from "zod";
import { Timestamp } from "./schemas.js";

const Id = z.string().min(1);

// ── §8 Tracing & decisions ────────────────────────────────────────────────────
export const TraceSpanSchema = z.object({
  traceId: Id,
  spanId: Id,
  parentSpanId: Id.optional(),
  module: z.string(),
  name: z.string(),
  startedAt: Timestamp,
  durationMs: z.number().nonnegative(),
  attrs: z.record(z.string(), z.unknown()),
});

export const DecisionLogSchema = z.object({
  traceId: Id,
  actor: z.string(),
  decision: z.string(),
  inputs: z.unknown(),
  output: z.unknown(),
  ts: Timestamp,
});

// ── §7 Health & resilience ────────────────────────────────────────────────────
export const HealthStatusSchema = z.object({
  module: z.string(),
  state: z.enum(["healthy", "degraded", "down"]),
  lastCheck: Timestamp,
  details: z.unknown().optional(),
});

export const CircuitStateSchema = z.object({
  target: z.string(),
  state: z.enum(["closed", "open", "half_open"]),
  failureRate: z.number().min(0).max(1),
  since: Timestamp,
});

export const DegradationPolicySchema = z.object({
  trigger: z.enum(["budget", "load", "failure"]),
  actions: z.array(
    z.enum(["lower_fps", "lower_res", "lightweight_model", "defer_noncritical"]),
  ),
});

// ── Canonical event-bus topic names ───────────────────────────────────────────
/** The canonical topic names every module publishes/subscribes against. */
export const TOPICS = {
  mediaSegmentCreated: "media.segment.created",
  querySubmitted: "query.submitted",
  pipelineCreated: "pipeline.created",
  jobStatusChanged: "job.status.changed",
  resultEvent: "result.event",
  computeLeaseGranted: "compute.lease.granted",
  usageRecorded: "usage.recorded",
  budgetThreshold: "budget.threshold",
  alertRaised: "alert.raised",
  traceSpan: "trace.span",
  decisionLogged: "decision.logged",
  dlqFailed: "dlq.failed",
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];

// ── inferred TS types ─────────────────────────────────────────────────────────
export type TraceSpan = z.infer<typeof TraceSpanSchema>;
export type DecisionLog = z.infer<typeof DecisionLogSchema>;
export type HealthStatus = z.infer<typeof HealthStatusSchema>;
export type CircuitState = z.infer<typeof CircuitStateSchema>;
export type DegradationPolicy = z.infer<typeof DegradationPolicySchema>;
