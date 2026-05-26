import { describe, it, expect } from "vitest";
import type { InferenceRequest } from "@gentech/contracts";
import { MockBackend } from "../dist/index.js";

const detectReq: InferenceRequest = {
  requestId: "req_1",
  jobId: "job_1",
  nodeId: "node_detect",
  modelId: "yolo-s",
  segment: { segmentId: "seg_lot_0", storageRef: "mock://seg/0" },
  params: { task: "object_detection" },
};

describe("seeded determinism (FR-3)", () => {
  it("same {scenario, seed} → byte-identical inference output", async () => {
    const a = await new MockBackend({ scenarioId: "parking_lot_daytime", seed: "abc" }).infer(detectReq);
    const b = await new MockBackend({ scenarioId: "parking_lot_daytime", seed: "abc" }).infer(detectReq);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("different seed → different jitter (still same set of objects)", async () => {
    const a = await new MockBackend({ scenarioId: "parking_lot_daytime", seed: "abc" }).infer(detectReq);
    const b = await new MockBackend({ scenarioId: "parking_lot_daytime", seed: "xyz" }).infer(detectReq);
    // same ground-truth ids (deterministic structure)…
    expect(a.detections!.map((d) => d.attrs!.id).sort()).toEqual(b.detections!.map((d) => d.attrs!.id).sort());
    // …but bboxes jitter with the seed
    expect(JSON.stringify(a.detections!.map((d) => d.bbox))).not.toBe(
      JSON.stringify(b.detections!.map((d) => d.bbox)),
    );
  });
});
