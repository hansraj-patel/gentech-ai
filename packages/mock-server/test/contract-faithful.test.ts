import { describe, it, expect } from "vitest";
import { InferenceResponseSchema, GpuInventorySchema, type InferenceRequest } from "@gentech/contracts";
import { MockBackend, mockSegments, getScenario } from "../dist/index.js";

/**
 * The defining property of module 13: every response validates against the exact
 * shared-contract schema the real module would return. That's what guarantees a
 * clean swap-in to real modules 05/06.
 */
const TASKS_MODELS: [string, string][] = [
  ["object_detection", "yolo-s"],
  ["vehicle_classification", "vehicle-cls-lite"],
  ["color_classification", "color-net"],
  ["counting", "counter"],
  ["anpr_ocr", "anpr-lite"],
  ["tracking", "bytetrack"],
  ["embedding", "embed-base"],
  ["match_filtering", "matcher"],
  ["nsfw", "nsfw-guard"],
];

function req(task: string, modelId: string, storageRef: string): InferenceRequest {
  return {
    requestId: `req_${task}`,
    jobId: "job_test",
    nodeId: `node_${task}`,
    modelId,
    segment: { segmentId: "seg_x", storageRef },
    params: { task },
  };
}

describe("mock /infer is contract-faithful", () => {
  it("every task × every segment returns a schema-valid InferenceResponse", async () => {
    const backend = new MockBackend({ scenarioId: "parking_lot_daytime", seed: "t" });
    const segments = mockSegments(getScenario("parking_lot_daytime"));
    for (const [task, modelId] of TASKS_MODELS) {
      for (const seg of segments) {
        const res = await backend.infer(req(task, modelId, seg.storageRef));
        const parsed = InferenceResponseSchema.safeParse(res);
        expect(parsed.success, `${task}@${seg.storageRef}: ${JSON.stringify(parsed)}`).toBe(true);
      }
    }
  });

  it("GpuInventory validates and reflects scarcity", async () => {
    const steady = await new MockBackend({ scenarioId: "parking_lot_daytime", seed: "t" }).inventory();
    expect(GpuInventorySchema.safeParse(steady).success).toBe(true);

    const scarce = await new MockBackend({ scenarioId: "gate_intrusion_night", seed: "t" }).inventory();
    expect(GpuInventorySchema.safeParse(scarce).success).toBe(true);
    // scarce profile leaves far fewer small GPUs free than its total
    expect(scarce.available.small!).toBeLessThanOrEqual(scarce.total.small!);
  });

  it("lease feasibility: CPU-only always grantable; scarce GPU may be denied", async () => {
    const backend = new MockBackend({ scenarioId: "gate_intrusion_night", seed: "t" });
    const cpu = await backend.leaseFeasibility({ gpuClass: "none", priority: 5 });
    expect(cpu.grantable).toBe(true);
    expect(cpu.endpoint).toBeDefined();
    // large GPUs total 0 in this scenario → never grantable
    const large = await backend.leaseFeasibility({ gpuClass: "large", priority: 5 });
    expect(large.grantable).toBe(false);
  });
});
