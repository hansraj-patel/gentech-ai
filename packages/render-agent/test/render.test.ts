import { describe, it, expect } from "vitest";
import { render, blockForResult, KIND_TO_COMPONENT } from "../dist/index.js";
import { getComponentSpec, UISpecSchema } from "@gentech/contracts";
import type { ResultEvent, RenderContext, UIComponentKind } from "@gentech/contracts";

const ctx: RenderContext = { tenantId: "ten_x", role: "analyst", query: "how many white cars?" };
const opts = { queryId: "query_1", jobId: "job_1" };

/** A base ResultEvent with the given kind/payload (defaults to non-partial). */
function ev(kind: ResultEvent["kind"], payload: unknown, over: Partial<ResultEvent> = {}): ResultEvent {
  return {
    resultId: `res_${kind}`,
    jobId: "job_1",
    tenantId: "ten_x",
    kind,
    partial: false,
    payload,
    ts: "2026-05-26T00:00:00.000Z",
    ...over,
  };
}

const FIXTURES: Record<ResultEvent["kind"], ResultEvent> = {
  count: ev("count", { label: "white cars", value: 7, unit: "cars" }),
  timeseries: ev("timeseries", {
    title: "cars/min",
    series: [{ name: "cars", points: [{ x: 0, y: 1 }, { x: 1, y: 3 }] }],
  }),
  detections: ev("detections", {
    segmentRef: "seg_1",
    detections: [
      { label: "car", confidence: 0.91, bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } },
      { label: "car", confidence: 0.8, bbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } },
    ],
  }),
  tracks: ev("tracks", {
    tracks: [
      { trackId: "t1", label: "car", points: [{ t: 0, bbox: { x: 0, y: 0, w: 0.1, h: 0.1 } }] },
      { trackId: "t2", label: "van", points: [{ t: 2, bbox: { x: 0, y: 0, w: 0.1, h: 0.1 } }] },
    ],
  }),
  match: ev("match", { title: "Best match", body: "Vehicle ABC123 matched at 00:14", stats: [{ label: "score", value: 0.97 }] }),
  heatmap: ev("heatmap", { grid: [[0, 1], [2, 3]] }),
  summary: ev("summary", { title: "Summary", body: "7 white cars detected over 5 minutes." }),
  table: ev("table", { columns: ["lane", "count"], rows: [["A", 3], ["B", 4]] }),
};

const EXPECTED_KIND: Record<ResultEvent["kind"], UIComponentKind> = {
  count: "counter",
  timeseries: "line_chart",
  detections: "table",
  tracks: "timeline",
  match: "summary_card",
  heatmap: "heatmap",
  summary: "summary_card",
  table: "table",
};

describe("render — golden UISpec per ResultKind", () => {
  for (const kind of Object.keys(FIXTURES) as ResultEvent["kind"][]) {
    it(`maps ${kind} → ${EXPECTED_KIND[kind]} with registry-valid props`, () => {
      const spec = render([FIXTURES[kind]], ctx, opts);
      // Whole spec is a valid UISpec.
      expect(() => UISpecSchema.parse(spec)).not.toThrow();
      expect(spec.queryId).toBe("query_1");
      expect(spec.jobId).toBe("job_1");
      expect(spec.partial).toBe(false);

      const primary = spec.blocks[0];
      expect(primary.kind).toBe(EXPECTED_KIND[kind]);
      expect(primary.sourceResultIds).toEqual([`res_${kind}`]);

      // Every block's props parse against its registry schema.
      for (const block of spec.blocks) {
        expect(() => getComponentSpec(block.kind).propsSchema.parse(block.props)).not.toThrow();
      }
    });
  }

  it("detections with bbox data also yields a video_overlay block", () => {
    const spec = render([FIXTURES.detections], ctx, opts);
    const kinds = spec.blocks.map((b) => b.kind);
    expect(kinds).toContain("table");
    expect(kinds).toContain("video_overlay");
    const overlay = spec.blocks.find((b) => b.kind === "video_overlay")!;
    expect(() => getComponentSpec("video_overlay").propsSchema.parse(overlay.props)).not.toThrow();
    expect((overlay.props as { boxes: unknown[] }).boxes).toHaveLength(2);
  });

  it("detections without bbox data yields only a table", () => {
    const spec = render([ev("detections", { detections: [{ label: "car", confidence: 0.5 }] })], ctx, opts);
    expect(spec.blocks.map((b) => b.kind)).toEqual(["table"]);
  });
});

describe("KIND_TO_COMPONENT mapping table", () => {
  it("matches the expected primary component for every kind", () => {
    expect(KIND_TO_COMPONENT).toEqual(EXPECTED_KIND);
  });
});

describe("blockForResult helper", () => {
  it("returns a single block for count and an array for detections", () => {
    expect(Array.isArray(blockForResult(FIXTURES.count))).toBe(false);
    expect(Array.isArray(blockForResult(FIXTURES.detections))).toBe(true);
  });
});

describe("partial propagation", () => {
  it("spec.partial is true if any input result is partial", () => {
    const spec = render(
      [FIXTURES.count, ev("summary", { title: "s", body: "b" }, { resultId: "res_p", partial: true })],
      ctx,
      opts,
    );
    expect(spec.partial).toBe(true);
  });

  it("spec.partial is false when all results are final", () => {
    const spec = render([FIXTURES.count, FIXTURES.summary], ctx, opts);
    expect(spec.partial).toBe(false);
  });
});

describe("empty input", () => {
  it("yields a single summary_card notice", () => {
    const spec = render([], ctx, opts);
    expect(() => UISpecSchema.parse(spec)).not.toThrow();
    expect(spec.blocks).toHaveLength(1);
    expect(spec.blocks[0].kind).toBe("summary_card");
    expect(spec.partial).toBe(false);
  });
});

describe("determinism", () => {
  it("same input twice ⇒ deep-equal specs", () => {
    const all = Object.values(FIXTURES);
    const a = render(all, ctx, opts);
    const b = render(all, ctx, opts);
    expect(a).toEqual(b);
  });

  it("ids carry no clock/random — stable across calls", () => {
    const a = render([FIXTURES.count], ctx, opts);
    const b = render([FIXTURES.count], ctx, opts);
    expect(a.specId).toBe(b.specId);
    expect(a.blocks[0].blockId).toBe(b.blocks[0].blockId);
  });
});
