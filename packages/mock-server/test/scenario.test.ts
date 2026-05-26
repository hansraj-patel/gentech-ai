import { describe, it, expect } from "vitest";
import type { InferenceRequest } from "@gentech/contracts";
import { MockBackend, mockSegments, getScenario } from "../dist/index.js";

/**
 * Ground-truth coherence (FR-2): running object detection across every segment of
 * "parking_lot_daytime" and counting distinct white cars must return the scenario's
 * intended answer (4), reproducibly under a fixed seed. (The full count-via-engine
 * path is covered in the engine's e2e test; here we prove the mock's data is right.)
 */
describe("parking_lot_daytime ground truth", () => {
  it("detects exactly 4 distinct white cars across the clip", async () => {
    const backend = new MockBackend({ scenarioId: "parking_lot_daytime", seed: "demo" });
    const segments = mockSegments(getScenario("parking_lot_daytime"));

    const whiteCarIds = new Set<string>();
    for (const seg of segments) {
      const req: InferenceRequest = {
        requestId: `req_${seg.index}`,
        jobId: "job_1",
        nodeId: "node_detect",
        modelId: "yolo-s",
        segment: { segmentId: seg.segmentId, storageRef: seg.storageRef },
        params: { task: "object_detection" },
      };
      const res = await backend.infer(req);
      for (const d of res.detections ?? []) {
        if (d.label === "car" && d.attrs?.color === "white") whiteCarIds.add(d.attrs.id!);
      }
    }
    expect(whiteCarIds.size).toBe(4);
  });

  it("is reproducible under a fixed seed", async () => {
    const run = async () => {
      const backend = new MockBackend({ scenarioId: "parking_lot_daytime", seed: "fixed" });
      const ids: string[] = [];
      for (const seg of mockSegments(getScenario("parking_lot_daytime"))) {
        const res = await backend.infer({
          requestId: "r",
          jobId: "j",
          nodeId: "n",
          modelId: "yolo-s",
          segment: { segmentId: seg.segmentId, storageRef: seg.storageRef },
          params: { task: "object_detection" },
        });
        ids.push(...(res.detections ?? []).map((d) => d.attrs!.id!));
      }
      return ids;
    };
    expect(await run()).toEqual(await run());
  });

  it("fires the intrusion alert on the simulated clock (FR-6)", () => {
    const backend = new MockBackend({ scenarioId: "gate_intrusion_night", seed: "demo", speed: 10 });
    const fired: string[] = [];
    for (let i = 0; i < 8; i++) fired.push(...backend.advance(1).map((e) => e.kind));
    expect(fired).toContain("intrusion");
  });
});
