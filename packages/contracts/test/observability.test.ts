import { describe, it, expect } from "vitest";
import {
  TraceSpanSchema,
  DecisionLogSchema,
  HealthStatusSchema,
  CircuitStateSchema,
  DegradationPolicySchema,
  TOPICS,
} from "../dist/index.js";

const NOW = "2026-05-26T18:00:00Z";

describe("observability schemas — accept valid fixtures", () => {
  it("TraceSpan (with and without parentSpanId)", () => {
    expect(
      TraceSpanSchema.safeParse({
        traceId: "trace_1",
        spanId: "span_1",
        parentSpanId: "span_0",
        module: "engine",
        name: "execute-node",
        startedAt: NOW,
        durationMs: 12,
        attrs: { nodeId: "node_detect" },
      }).success,
    ).toBe(true);

    expect(
      TraceSpanSchema.safeParse({
        traceId: "trace_1",
        spanId: "span_root",
        module: "orchestrator",
        name: "plan",
        startedAt: NOW,
        durationMs: 0,
        attrs: {},
      }).success,
    ).toBe(true);
  });

  it("DecisionLog / HealthStatus / CircuitState", () => {
    expect(
      DecisionLogSchema.safeParse({
        traceId: "trace_1",
        actor: "safety",
        decision: "allow",
        inputs: { text: "how many cars?" },
        output: { verdict: "ok" },
        ts: NOW,
      }).success,
    ).toBe(true);

    expect(
      HealthStatusSchema.safeParse({
        module: "engine",
        state: "degraded",
        lastCheck: NOW,
        details: { reason: "high latency" },
      }).success,
    ).toBe(true);

    expect(
      CircuitStateSchema.safeParse({
        target: "inference",
        state: "half_open",
        failureRate: 0.42,
        since: NOW,
      }).success,
    ).toBe(true);
  });

  it("DegradationPolicy", () => {
    expect(
      DegradationPolicySchema.safeParse({
        trigger: "budget",
        actions: ["lower_fps", "lightweight_model", "defer_noncritical"],
      }).success,
    ).toBe(true);
  });
});

describe("observability schemas — reject bad fixtures", () => {
  it("rejects negative durationMs", () => {
    expect(
      TraceSpanSchema.safeParse({
        traceId: "trace_1",
        spanId: "span_1",
        module: "engine",
        name: "x",
        startedAt: NOW,
        durationMs: -1,
        attrs: {},
      }).success,
    ).toBe(false);
  });

  it("rejects out-of-range failureRate and bad circuit state", () => {
    expect(
      CircuitStateSchema.safeParse({
        target: "inference",
        state: "closed",
        failureRate: 1.5,
        since: NOW,
      }).success,
    ).toBe(false);

    expect(
      CircuitStateSchema.safeParse({
        target: "inference",
        state: "melted",
        failureRate: 0.1,
        since: NOW,
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown degradation action", () => {
    expect(
      DegradationPolicySchema.safeParse({ trigger: "load", actions: ["explode"] }).success,
    ).toBe(false);
  });
});

describe("TOPICS canonical names", () => {
  it("maps the documented topic names", () => {
    expect(TOPICS.resultEvent).toBe("result.event");
    expect(TOPICS.jobStatusChanged).toBe("job.status.changed");
    expect(TOPICS.traceSpan).toBe("trace.span");
    expect(TOPICS.dlqFailed).toBe("dlq.failed");
    expect(Object.keys(TOPICS)).toHaveLength(12);
  });
});
