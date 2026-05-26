import { describe, it, expect } from "vitest";
import { PipelineEngine, InMemoryEventSink, topoLevels } from "../dist/index.js";
import type { InferenceRequest, InferenceResponse } from "@gentech/contracts";
import { AUTH, grantAllCompute, node, spec, segments, inferenceClient } from "./helpers.js";

// diamond: a → b, a → c, b → d, c → d  (b and c are independent → one level)
const diamond = spec(
  [node("a", "object_detection", "yolo-n"), node("b", "anpr_ocr", "anpr-lite"), node("c", "tracking", "bytetrack"), node("d", "match_filtering", "matcher")],
  [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "b", to: "d" }, { from: "c", to: "d" }],
);

describe("topoLevels", () => {
  it("groups independent nodes into the same level", () => {
    const levels = topoLevels(diamond).map((lvl) => lvl.map((n) => n.nodeId).sort());
    expect(levels).toEqual([["a"], ["b", "c"], ["d"]]);
  });
});

describe("DAG execution", () => {
  it("respects edges and runs an independent level concurrently", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const firstSeen: string[] = [];

    // infer resolves on a later tick so concurrent calls overlap and we can measure it
    const client = {
      async infer(req: InferenceRequest): Promise<InferenceResponse> {
        if (!firstSeen.includes(req.nodeId)) firstSeen.push(req.nodeId);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return { requestId: req.requestId, modelId: req.modelId, latencyMs: 5 };
      },
    };

    const engine = new PipelineEngine();
    const sink = new InMemoryEventSink();
    await engine.run(diamond, segments(1), AUTH, { inference: client, compute: grantAllCompute, sink });

    // b and c (same level) were in flight simultaneously
    expect(maxInFlight).toBeGreaterThanOrEqual(2);
    // edges honored: a before b/c; b and c before d
    expect(firstSeen.indexOf("a")).toBeLessThan(firstSeen.indexOf("b"));
    expect(firstSeen.indexOf("a")).toBeLessThan(firstSeen.indexOf("c"));
    expect(firstSeen.indexOf("b")).toBeLessThan(firstSeen.indexOf("d"));
    expect(firstSeen.indexOf("c")).toBeLessThan(firstSeen.indexOf("d"));
  });

  it("cancels mid-run when the signal aborts", async () => {
    const controller = new AbortController();
    const client = inferenceClient((req) => {
      controller.abort(); // abort on the very first inference
      return { requestId: req.requestId, modelId: req.modelId, latencyMs: 1 };
    });
    const engine = new PipelineEngine();
    const { job } = await engine.run(spec([node("a", "object_detection", "yolo-n")], []), segments(4), AUTH, {
      inference: client,
      compute: grantAllCompute,
    }, { signal: controller.signal });
    expect(job.state).toBe("cancelled");
  });
});
