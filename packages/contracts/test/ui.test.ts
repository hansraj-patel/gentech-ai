import { describe, it, expect } from "vitest";
import {
  UISpecSchema,
  UIBlockSchema,
  UIComponentKindSchema,
  RenderContextSchema,
  UIComponentRegistry,
  getComponentSpec,
} from "../dist/index.js";

describe("ui schemas — accept valid fixtures", () => {
  it("parses a valid UISpec with multiple blocks", () => {
    const spec = {
      specId: "spec_1",
      queryId: "q_1",
      jobId: "job_1",
      partial: true,
      explanation: "answering 'how many white cars?'",
      blocks: [
        {
          blockId: "b_count",
          kind: "counter",
          props: { label: "white cars", value: 7, unit: "vehicles" },
          sourceResultIds: ["result_1"],
        },
        {
          blockId: "b_table",
          kind: "table",
          props: { columns: ["time", "label"], rows: [["00:01", "car"]] },
        },
      ],
    };
    expect(UISpecSchema.safeParse(spec).success).toBe(true);
  });

  it("parses a RenderContext", () => {
    expect(
      RenderContextSchema.safeParse({
        tenantId: "ten_1",
        role: "analyst",
        query: "how many white cars?",
        locale: "en-US",
      }).success,
    ).toBe(true);
  });
});

describe("ui schemas — reject bad fixtures", () => {
  it("rejects a UISpec whose block has an unknown kind", () => {
    const spec = {
      specId: "spec_1",
      queryId: "q_1",
      partial: false,
      blocks: [{ blockId: "b_x", kind: "hologram", props: {} }],
    };
    expect(UISpecSchema.safeParse(spec).success).toBe(false);
  });

  it("rejects a block missing required props record", () => {
    expect(
      UIBlockSchema.safeParse({ blockId: "b", kind: "counter" }).success,
    ).toBe(false);
  });
});

describe("UIComponentRegistry", () => {
  const allKinds = UIComponentKindSchema.options;

  it("has an entry for all 9 component kinds", () => {
    expect(allKinds).toHaveLength(9);
    for (const kind of allKinds) {
      expect(UIComponentRegistry[kind]).toBeDefined();
      expect(getComponentSpec(kind)).toBe(UIComponentRegistry[kind]);
      expect(Array.isArray(UIComponentRegistry[kind].consumes)).toBe(true);
      expect(UIComponentRegistry[kind].consumes.length).toBeGreaterThan(0);
    }
  });

  it("each propsSchema parses a representative props object", () => {
    const samples: Record<string, unknown> = {
      counter: { label: "cars", value: 7, unit: "x", delta: 1 },
      line_chart: { title: "t", series: [{ name: "s", points: [{ x: 0, y: 1 }] }] },
      bar_chart: { title: "t", labels: ["a", "b"], values: [1, 2] },
      timeline: { events: [{ t: 0, label: "enter" }] },
      heatmap: { grid: [[0, 1], [1, 0]] },
      table: { columns: ["a"], rows: [["x"]] },
      video_overlay: {
        segmentRef: "seg_0",
        boxes: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.4, label: "car" }],
      },
      map: { points: [{ lat: 1.1, lng: 2.2, label: "cam" }] },
      summary_card: { title: "t", body: "b", stats: [{ label: "n", value: 3 }] },
    };
    for (const kind of allKinds) {
      const result = UIComponentRegistry[kind].propsSchema.safeParse(samples[kind]);
      expect(result.success, `propsSchema for ${kind} should accept its sample`).toBe(true);
    }
  });

  it("consumes only reference valid ResultKind values", () => {
    const validKinds = new Set([
      "count",
      "timeseries",
      "detections",
      "tracks",
      "match",
      "heatmap",
      "summary",
      "table",
    ]);
    for (const kind of allKinds) {
      for (const consumed of UIComponentRegistry[kind].consumes) {
        expect(validKinds.has(consumed)).toBe(true);
      }
    }
  });
});
