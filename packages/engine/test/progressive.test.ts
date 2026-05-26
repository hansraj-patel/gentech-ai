import { describe, it, expect } from "vitest";
import { PipelineEngine, InMemoryEventSink } from "../dist/index.js";
import { AUTH, grantAllCompute, node, spec, segments, inferenceClient, okResponse } from "./helpers.js";

/**
 * FR-3: a multi-segment job emits partial:true results as segments arrive, then a
 * succeeded job with finalized results. (Counts grow monotonically because each
 * segment carries a fresh distinct detection id.)
 */
describe("progressive results", () => {
  it("emits partial results before the final, then succeeds", async () => {
    const s = spec(
      [node("detect", "object_detection", "yolo-n", { classes: ["car"] }), node("count", "counting", "counter")],
      [{ from: "detect", to: "count" }],
    );
    const engine = new PipelineEngine({ baseBackoffMs: 1 });
    const sink = new InMemoryEventSink();
    const { job, results } = await engine.run(s, segments(4), AUTH, {
      inference: inferenceClient(okResponse),
      compute: grantAllCompute,
      sink,
    });

    expect(results.length).toBe(4); // one aggregation per segment
    expect(results.slice(0, 3).every((r) => r.partial)).toBe(true);
    expect(results.at(-1)!.partial).toBe(false);

    // count grows as segments arrive and finalizes at 4 distinct detections
    const counts = results.map((r) => (r.payload as { count: number }).count);
    expect(counts).toEqual([1, 2, 3, 4]);
    expect(job.state).toBe("succeeded");
    expect(job.progress).toBe(1);

    // status events were emitted progressively
    expect(sink.byTopic("job.status.changed").length).toBeGreaterThanOrEqual(4);
  });
});
