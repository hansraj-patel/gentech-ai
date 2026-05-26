import { describe, it, expect } from "vitest";
import { ModelRegistry, defaultRegistry } from "../dist/index.js";

describe("ModelRegistry.findModels", () => {
  it("ranks candidates cheapest-first deterministically", () => {
    const r = defaultRegistry.findModels("object_detection");
    expect(r.map((m) => m.modelId)).toEqual(["yolo-n", "yolo-s", "yolo-m"]);
  });

  it("honors the minQuality floor", () => {
    const r = defaultRegistry.findModels("object_detection", { minQuality: "high" });
    expect(r.map((m) => m.modelId)).toEqual(["yolo-m"]);
  });

  it("honors maxLatencyMs", () => {
    const r = defaultRegistry.findModels("object_detection", { maxLatencyMs: 10 });
    expect(r.map((m) => m.modelId)).toEqual(["yolo-n"]);
  });

  it("returns empty for an unknown task", () => {
    expect(defaultRegistry.findModels("teleportation")).toEqual([]);
  });

  it("covers every ontology capability used by the example queries", () => {
    for (const task of [
      "object_detection",
      "vehicle_classification",
      "color_classification",
      "counting",
      "anpr_ocr",
      "tracking",
      "match_filtering",
    ]) {
      expect(defaultRegistry.findModels(task).length).toBeGreaterThan(0);
    }
  });

  it("is constructable from a fixture snapshot", () => {
    const r = new ModelRegistry([]);
    expect(r.findModels("object_detection")).toEqual([]);
    expect(r.modelIds.size).toBe(0);
  });
});
