import { describe, it, expect } from "vitest";
import { PipelineEngine, InMemoryEventSink, withRetry } from "../dist/index.js";
import { AUTH, grantAllCompute, node, spec, segments, okResponse } from "./helpers.js";
import type { InferenceRequest } from "@gentech/contracts";

describe("withRetry", () => {
  it("retries up to maxRetries then succeeds", async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error("transient");
        return "ok";
      },
      { maxRetries: 3, backoff: "fixed", deadLetter: true },
      { baseMs: 1 },
    );
    expect(out).toBe("ok");
    expect(calls).toBe(3);
  });

  it("rethrows after exhausting retries", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => { calls += 1; throw new Error("always"); }, { maxRetries: 2, backoff: "fixed", deadLetter: true }, { baseMs: 1 }),
    ).rejects.toThrow("always");
    expect(calls).toBe(3); // initial + 2 retries
  });
});

describe("a failing node dead-letters without losing other results", () => {
  it("preserves the good node's detections and DLQs the bad node", async () => {
    // two independent roots: detect (good) + anpr (always fails)
    const s = spec([node("detect", "object_detection", "yolo-n"), node("anpr", "anpr_ocr", "anpr-lite")], []);

    const client = {
      async infer(req: InferenceRequest) {
        if (req.nodeId === "anpr") throw new Error("model crashed");
        return okResponse(req);
      },
    };

    const engine = new PipelineEngine({ baseBackoffMs: 1, breakerThreshold: 1 });
    const sink = new InMemoryEventSink();
    const { job, results } = await engine.run(s, segments(3), AUTH, { inference: client, compute: grantAllCompute, sink });

    // the bad node dead-lettered
    expect(sink.byTopic("dlq.failed").length).toBeGreaterThan(0);
    expect(job.nodeStates.anpr).toBe("failed");
    // …but the good node's results across all 3 segments survived (checkpointing)
    const finalDetections = (results.at(-1)!.payload as { count: number }).count;
    expect(finalDetections).toBe(3); // one distinct detection per segment
    expect(job.state).toBe("degraded");
  });

  it("opens the circuit breaker so a failing node is skipped after the threshold", async () => {
    const s = spec([node("detect", "object_detection", "yolo-n")], []);
    let attempts = 0;
    const client = {
      async infer(req: InferenceRequest) {
        attempts += 1;
        throw new Error("down");
      },
    };
    const engine = new PipelineEngine({ baseBackoffMs: 1, breakerThreshold: 1 });
    const { job } = await engine.run(s, segments(5), AUTH, { inference: client, compute: grantAllCompute });
    // segment 0: 1 initial + 2 retries = 3 attempts, then breaker opens → no more infer calls
    expect(attempts).toBe(3);
    expect(job.nodeStates.detect).toMatch(/failed|skipped/);
  });
});
