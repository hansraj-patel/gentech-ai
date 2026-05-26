/**
 * Generative-UI contracts — module 08 / §9. The render-agent produces a
 * `UISpec` (a list of typed `UIBlock`s) from `ResultEvent`s; the web app
 * renders each block with the component named by its `kind`. `UIComponentRegistry`
 * is the single source of truth shared by the renderer and the web app: it pins
 * the valid props shape for each component and which `ResultKind`s feed it.
 *
 * As everywhere in this package, zod is the single source of truth and TS types
 * are inferred via z.infer. `ResultKind` is reused from `runtime.ts` rather than
 * redefined so the consumer mapping stays in lockstep with the result schema.
 */
import { z } from "zod";
import { ResultKind } from "./runtime.js";

const Id = z.string().min(1);

// ── §9 Component kinds & blocks ───────────────────────────────────────────────
export const UIComponentKindSchema = z.enum([
  "counter",
  "line_chart",
  "bar_chart",
  "timeline",
  "heatmap",
  "table",
  "video_overlay",
  "map",
  "summary_card",
]);
export type UIComponentKind = z.infer<typeof UIComponentKindSchema>;

export const UIBlockSchema = z.object({
  blockId: Id,
  kind: UIComponentKindSchema,
  props: z.record(z.string(), z.unknown()),
  sourceResultIds: z.array(z.string()).optional(),
});
export type UIBlock = z.infer<typeof UIBlockSchema>;

export const UISpecSchema = z.object({
  specId: Id,
  queryId: Id,
  jobId: z.string().optional(),
  blocks: z.array(UIBlockSchema),
  partial: z.boolean(),
  explanation: z.string().optional(),
});
export type UISpec = z.infer<typeof UISpecSchema>;

export const RenderContextSchema = z.object({
  tenantId: Id,
  role: z.string(),
  query: z.string(),
  locale: z.string().optional(),
});
export type RenderContext = z.infer<typeof RenderContextSchema>;

// ── Per-component props schemas ───────────────────────────────────────────────
// Permissive but real — `.passthrough()` lets renderers carry extra hints while
// the named fields stay validated.
const CounterProps = z
  .object({
    label: z.string(),
    value: z.number(),
    unit: z.string().optional(),
    delta: z.number().optional(),
  })
  .passthrough();

const SeriesPoint = z.object({ x: z.union([z.number(), z.string()]), y: z.number() });
const ChartProps = z
  .object({
    title: z.string().optional(),
    series: z.array(z.object({ name: z.string(), points: z.array(SeriesPoint) })).optional(),
    labels: z.array(z.string()).optional(),
    values: z.array(z.number()).optional(),
  })
  .passthrough();

const TimelineProps = z
  .object({
    events: z.array(z.object({ t: z.union([z.number(), z.string()]), label: z.string() })),
  })
  .passthrough();

const HeatmapProps = z
  .object({
    grid: z.array(z.array(z.number())),
  })
  .passthrough();

const TableProps = z
  .object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.unknown())),
  })
  .passthrough();

const VideoOverlayProps = z
  .object({
    segmentRef: z.string(),
    boxes: z.array(
      z.object({
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number(),
        label: z.string().optional(),
      }),
    ),
  })
  .passthrough();

const MapProps = z
  .object({
    points: z.array(
      z.object({ lat: z.number(), lng: z.number(), label: z.string().optional() }),
    ),
  })
  .passthrough();

const SummaryCardProps = z
  .object({
    title: z.string(),
    body: z.string(),
    stats: z.array(z.object({ label: z.string(), value: z.union([z.number(), z.string()]) })).optional(),
  })
  .passthrough();

// ── Component registry ────────────────────────────────────────────────────────
type ResultKindValue = z.infer<typeof ResultKind>;

export interface ComponentSpec {
  propsSchema: z.ZodTypeAny;
  consumes: ResultKindValue[];
}

/**
 * Single source of truth for valid props per `UIComponentKind` and which
 * `ResultKind`s each component renders. Shared by the render-agent (to validate
 * the blocks it emits) and the web app (to map kinds → safe components).
 */
export const UIComponentRegistry: Record<UIComponentKind, ComponentSpec> = {
  counter: { propsSchema: CounterProps, consumes: ["count"] },
  line_chart: { propsSchema: ChartProps, consumes: ["timeseries"] },
  bar_chart: { propsSchema: ChartProps, consumes: ["timeseries", "table"] },
  timeline: { propsSchema: TimelineProps, consumes: ["tracks"] },
  heatmap: { propsSchema: HeatmapProps, consumes: ["heatmap"] },
  table: { propsSchema: TableProps, consumes: ["detections", "table"] },
  video_overlay: { propsSchema: VideoOverlayProps, consumes: ["detections"] },
  map: { propsSchema: MapProps, consumes: ["detections"] },
  summary_card: { propsSchema: SummaryCardProps, consumes: ["match", "summary"] },
};

/** Look up the registry entry (props schema + consumed result kinds) for a kind. */
export function getComponentSpec(kind: UIComponentKind): ComponentSpec {
  return UIComponentRegistry[kind];
}
