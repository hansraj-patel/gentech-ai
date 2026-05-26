/**
 * Module 08 core — the render-agent. A deterministic, PURE function that turns
 * mocked analysis `ResultEvent`s into a generative-UI `UISpec`. This is the
 * "real intelligence produces UI" boundary: the analysis is faked upstream, but
 * the mapping from results → typed, registry-valid UI blocks is real logic.
 *
 * As everywhere in this platform, the §9 contracts in `@gentech/contracts` are
 * the single source of truth. Every block's `props` are validated against the
 * matching `UIComponentRegistry[kind].propsSchema` before it is emitted, so a
 * render always yields registry-valid blocks (or throws on a contract drift).
 *
 * Determinism: ids are derived from input index / `resultId` only — never from
 * `Date.now()` / random — so the same inputs always produce a deep-equal spec.
 */
import {
  type ResultEvent,
  type RenderContext,
  type UISpec,
  type UIBlock,
  type UIComponentKind,
  getComponentSpec,
} from "@gentech/contracts";

/** Options carrying ids the `RenderContext` does not itself hold. */
export interface RenderOptions {
  /** The query this spec answers — stamped onto `UISpec.queryId`. */
  queryId: string;
  /** Optional originating job id, carried onto `UISpec.jobId`. */
  jobId?: string;
  /** Optional human-facing explanation of what was rendered. */
  explanation?: string;
}

/**
 * The canonical `ResultKind` → primary `UIComponentKind` mapping. `detections`
 * additionally yields a `video_overlay` when the payload carries bbox data
 * (handled in `blockForResult`), so this table lists only the primary block.
 */
export const KIND_TO_COMPONENT: Record<ResultEvent["kind"], UIComponentKind> = {
  count: "counter",
  timeseries: "line_chart",
  detections: "table",
  tracks: "timeline",
  match: "summary_card",
  heatmap: "heatmap",
  summary: "summary_card",
  table: "table",
};

// ── payload coercion helpers ──────────────────────────────────────────────────
// Payloads are `z.unknown()` on the wire, so we read defensively and always emit
// something the per-component props schema will accept.

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function asNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Validate `props` against the registry schema for `kind`, throwing on drift. */
function makeBlock(
  blockId: string,
  kind: UIComponentKind,
  rawProps: Record<string, unknown>,
  sourceResultIds: string[],
): UIBlock {
  const props = getComponentSpec(kind).propsSchema.parse(rawProps) as Record<string, unknown>;
  return { blockId, kind, props, sourceResultIds };
}

// ── per-kind props builders ───────────────────────────────────────────────────

function counterProps(p: Record<string, unknown>): Record<string, unknown> {
  const value = asNumber(p.value ?? p.count);
  const out: Record<string, unknown> = {
    label: asString(p.label, "Count"),
    value,
  };
  if (typeof p.unit === "string") out.unit = p.unit;
  if (typeof p.delta === "number") out.delta = p.delta;
  return out;
}

function lineChartProps(p: Record<string, unknown>): Record<string, unknown> {
  const rawSeries = asArray(p.series);
  const series =
    rawSeries.length > 0
      ? rawSeries.map((s, i) => {
          const r = asRecord(s);
          return {
            name: asString(r.name, `series_${i}`),
            points: asArray(r.points).map((pt) => {
              const rp = asRecord(pt);
              return {
                x: typeof rp.x === "string" ? rp.x : asNumber(rp.x),
                y: asNumber(rp.y),
              };
            }),
          };
        })
      : [
          {
            name: asString(p.name, "series_0"),
            points: asArray(p.points).map((pt) => {
              const rp = asRecord(pt);
              return {
                x: typeof rp.x === "string" ? rp.x : asNumber(rp.x ?? rp.t),
                y: asNumber(rp.y ?? rp.value),
              };
            }),
          },
        ];
  const out: Record<string, unknown> = { series };
  if (typeof p.title === "string") out.title = p.title;
  return out;
}

function timelineProps(p: Record<string, unknown>): Record<string, unknown> {
  // `tracks` payloads: each track contributes a start/label entry; raw `events`
  // pass through if present.
  const rawEvents = asArray(p.events);
  if (rawEvents.length > 0) {
    return {
      events: rawEvents.map((e) => {
        const r = asRecord(e);
        return {
          t: typeof r.t === "string" ? r.t : asNumber(r.t),
          label: asString(r.label, "event"),
        };
      }),
    };
  }
  const tracks = asArray(p.tracks);
  return {
    events: tracks.map((tr, i) => {
      const r = asRecord(tr);
      const points = asArray(r.points);
      const first = asRecord(points[0]);
      return {
        t: asNumber(first.t, i),
        label: asString(r.label ?? r.trackId, `track_${i}`),
      };
    }),
  };
}

function heatmapProps(p: Record<string, unknown>): Record<string, unknown> {
  const grid = asArray(p.grid).map((row) => asArray(row).map((c) => asNumber(c)));
  return { grid: grid.length > 0 ? grid : [[0]] };
}

/** Build a generic table from `detections` or `table` payloads. */
function tableProps(p: Record<string, unknown>): Record<string, unknown> {
  // explicit columns/rows pass through
  if (Array.isArray(p.columns) && Array.isArray(p.rows)) {
    return {
      columns: (p.columns as unknown[]).map((c) => asString(c)),
      rows: (p.rows as unknown[]).map((r) => asArray(r)),
    };
  }
  // detections → label / confidence / bbox table
  const detections = asArray(p.detections);
  const columns = ["label", "confidence", "x", "y", "w", "h"];
  const rows = detections.map((d) => {
    const r = asRecord(d);
    const bbox = asRecord(r.bbox);
    return [
      asString(r.label, "?"),
      asNumber(r.confidence),
      asNumber(bbox.x),
      asNumber(bbox.y),
      asNumber(bbox.w),
      asNumber(bbox.h),
    ];
  });
  return { columns, rows };
}

/** A `video_overlay` block from detections that carry bbox data. */
function videoOverlayProps(p: Record<string, unknown>): Record<string, unknown> {
  const detections = asArray(p.detections);
  const boxes = detections
    .map((d) => asRecord(d))
    .filter((r) => r.bbox && typeof r.bbox === "object")
    .map((r) => {
      const bbox = asRecord(r.bbox);
      const box: Record<string, unknown> = {
        x: asNumber(bbox.x),
        y: asNumber(bbox.y),
        w: asNumber(bbox.w),
        h: asNumber(bbox.h),
      };
      if (typeof r.label === "string") box.label = r.label;
      return box;
    });
  return {
    segmentRef: asString(p.segmentRef ?? p.segmentId, "segment"),
    boxes,
  };
}

/** Does a `detections` payload carry any bbox data worth overlaying? */
function hasBboxData(p: Record<string, unknown>): boolean {
  return asArray(p.detections).some((d) => {
    const r = asRecord(d);
    return r.bbox != null && typeof r.bbox === "object";
  });
}

function summaryCardProps(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    title: asString(p.title, "Summary"),
    body: asString(p.body ?? p.text ?? p.summary, ""),
  };
  const stats = asArray(p.stats);
  if (stats.length > 0) {
    out.stats = stats.map((s) => {
      const r = asRecord(s);
      return {
        label: asString(r.label, "stat"),
        value: typeof r.value === "string" ? r.value : asNumber(r.value),
      };
    });
  }
  return out;
}

/**
 * Map a single `ResultEvent` to one or more `UIBlock`s. Pure and deterministic:
 * block ids are derived from `result.resultId` so repeated renders are stable.
 * `detections` yields a `table` and, when the payload carries bbox data, an
 * additional `video_overlay`.
 */
export function blockForResult(result: ResultEvent): UIBlock | UIBlock[] {
  const p = asRecord(result.payload);
  const src = [result.resultId];
  const base = `blk_${result.resultId}`;

  switch (result.kind) {
    case "count":
      return makeBlock(base, "counter", counterProps(p), src);
    case "timeseries":
      return makeBlock(base, "line_chart", lineChartProps(p), src);
    case "tracks":
      return makeBlock(base, "timeline", timelineProps(p), src);
    case "heatmap":
      return makeBlock(base, "heatmap", heatmapProps(p), src);
    case "match":
    case "summary":
      return makeBlock(base, "summary_card", summaryCardProps(p), src);
    case "table":
      return makeBlock(base, "table", tableProps(p), src);
    case "detections": {
      const blocks: UIBlock[] = [makeBlock(base, "table", tableProps(p), src)];
      if (hasBboxData(p)) {
        blocks.push(makeBlock(`${base}_overlay`, "video_overlay", videoOverlayProps(p), src));
      }
      return blocks;
    }
    default: {
      // Unknown/forward-compatible kind: degrade to a notice card rather than throw.
      const _exhaustive: never = result.kind;
      void _exhaustive;
      return makeBlock(
        base,
        "summary_card",
        summaryCardProps({ title: "Result", body: `Unrenderable result kind` }),
        src,
      );
    }
  }
}

/**
 * Render a batch of `ResultEvent`s into a single `UISpec`. Pure & deterministic:
 * given the same `results`, `ctx`, and `opts`, it returns a deep-equal spec.
 *
 * - Each result maps to one (or more) `UIBlock`s via `blockForResult`.
 * - `UISpec.partial` is true if ANY input result is `partial`.
 * - Empty input falls back to a single `summary_card` notice.
 * - `specId` is derived from `queryId` + result ids (no clock / random).
 */
export function render(results: ResultEvent[], ctx: RenderContext, opts: RenderOptions): UISpec {
  const partial = results.some((r) => r.partial === true);

  let blocks: UIBlock[];
  if (results.length === 0) {
    const q = ctx.query ? ` for "${ctx.query}"` : "";
    blocks = [
      makeBlock(
        "blk_empty",
        "summary_card",
        summaryCardProps({
          title: "No results",
          body: `No renderable results${q} yet.`,
        }),
        [],
      ),
    ];
  } else {
    blocks = results.flatMap((r) => {
      const b = blockForResult(r);
      return Array.isArray(b) ? b : [b];
    });
  }

  // Stable spec id: derived from the query and contributing result ids only.
  const idBasis = results.length > 0 ? results.map((r) => r.resultId).join(".") : "empty";
  const specId = `spec_${opts.queryId}_${idBasis}`;

  const spec: UISpec = {
    specId,
    queryId: opts.queryId,
    blocks,
    partial,
  };
  if (opts.jobId !== undefined) spec.jobId = opts.jobId;
  else if (results[0] !== undefined) spec.jobId = results[0].jobId;
  if (opts.explanation !== undefined) spec.explanation = opts.explanation;

  return spec;
}
