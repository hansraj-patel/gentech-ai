/**
 * Synthetic inference (module 13, FR-1/FR-2/FR-8): turn an InferenceRequest into a
 * schema-valid InferenceResponse *derived from the scenario's ground truth*, so the
 * whole demo is coherent ("white cars" → the real count) rather than random noise.
 *
 * Segment index convention: the mock owns the storageRef scheme `mock://seg/<n>`
 * (storageRef is an opaque blob pointer in the contract; the mock defines its own).
 * The engine never parses it — see `segments.ts`.
 */
import type { Detection, InferenceRequest, InferenceResponse, Track } from "@gentech/contracts";
import { InferenceResponseSchema } from "@gentech/contracts";
import { Rng } from "./rng.js";
import type { Scenario } from "./scenarios.js";

const VEHICLE_LABELS = new Set(["car", "truck", "bus", "van", "motorcycle"]);

/** Parse the mock's own segment index out of its storageRef scheme; default 0. */
export function segmentIndexOf(storageRef: string): number {
  const m = /\/seg\/(\d+)/.exec(storageRef);
  return m ? Number(m[1]) : 0;
}

/** Default per-task latency (ms) when no registry metadata lookup is supplied. */
const DEFAULT_LATENCY: Record<string, number> = {
  object_detection: 18,
  vehicle_classification: 8,
  color_classification: 5,
  counting: 1,
  anpr_ocr: 30,
  tracking: 14,
  embedding: 22,
  match_filtering: 2,
  nsfw: 8,
};

export interface InferOptions {
  seed: string | number;
  /** Optional: registry-backed latency (module 06's latencyMsEst) for realism (FR-8). */
  latencyLookup?: (modelId: string) => number | undefined;
}

function bbox(rng: Rng) {
  const x = rng.range(0.02, 0.8);
  const y = rng.range(0.02, 0.8);
  return { x, y, w: rng.range(0.05, 0.18), h: rng.range(0.05, 0.18) };
}

/** Map a capability task → which ground-truth objects become detections this segment. */
function detectionsForSegment(
  task: string,
  params: Record<string, unknown>,
  scenario: Scenario,
  segIdx: number,
  rng: Rng,
): Detection[] {
  const classes = Array.isArray(params.classes) ? (params.classes as string[]) : undefined;
  return scenario.groundTruth.objects
    .filter((o) => o.atSegment === segIdx)
    .filter((o) => {
      if (task === "vehicle_classification") return VEHICLE_LABELS.has(o.label);
      // detection/color: honor an explicit class filter if the planner set one
      if (classes && classes.length) return classes.includes(o.label);
      return true;
    })
    .map((o) => ({
      label: o.label,
      confidence: Number(rng.jitterUnit(0.92, 0.08).toFixed(3)),
      bbox: bbox(new Rng(rng.float(), o.id)),
      // carry stable identity + ground-truth attrs (color/type) so the engine can
      // dedup and filter; `id` is how counting avoids double-counting across nodes.
      attrs: { id: o.id, ...o.attrs },
    }));
}

function tracksForSegment(scenario: Scenario, segIdx: number, rng: Rng): Track[] {
  return scenario.groundTruth.tracks
    .filter((t) => t.segments.includes(segIdx))
    .map((t) => ({
      trackId: t.trackId,
      label: t.label,
      points: t.segments.map((s) => ({ t: s, bbox: bbox(new Rng(rng.float(), t.trackId, s)) })),
    }));
}

/** Produce a schema-valid InferenceResponse derived from ground truth. */
export function inferFromGroundTruth(
  req: InferenceRequest,
  scenario: Scenario,
  opts: InferOptions,
): InferenceResponse {
  const segIdx = segmentIndexOf(req.segment.storageRef);
  const task = String(req.params.task ?? inferTaskFromModel(req.modelId));
  const rng = new Rng(opts.seed, req.segment.segmentId, req.modelId, segIdx);
  const latencyMs =
    opts.latencyLookup?.(req.modelId) ?? DEFAULT_LATENCY[task] ?? 10;

  const base = { requestId: req.requestId, modelId: req.modelId, latencyMs };
  let response: InferenceResponse;

  switch (task) {
    case "object_detection":
    case "vehicle_classification":
    case "color_classification":
      response = { ...base, detections: detectionsForSegment(task, req.params, scenario, segIdx, rng) };
      break;
    case "anpr_ocr":
      response = {
        ...base,
        ocr: scenario.groundTruth.anpr
          .filter((a) => a.atSegment === segIdx)
          .map((a) => ({
            text: a.plate,
            confidence: Number(rng.jitterUnit(0.9, 0.08).toFixed(3)),
            bbox: bbox(new Rng(rng.float(), a.plate)),
          })),
      };
      break;
    case "tracking":
      response = { ...base, tracks: tracksForSegment(scenario, segIdx, rng) };
      break;
    case "embedding": {
      const objs = scenario.groundTruth.objects.filter((o) => o.atSegment === segIdx);
      response = {
        ...base,
        embeddings: objs.map((o) => {
          const r = new Rng(opts.seed, o.id);
          return Array.from({ length: 8 }, () => Number(r.range(-1, 1).toFixed(4)));
        }),
      };
      break;
    }
    case "nsfw":
      response = { ...base, nsfwScore: Number(rng.jitterUnit(scenario.groundTruth.nsfwScore, 0.01).toFixed(3)) };
      break;
    // counting / match_filtering are pure aggregation — the engine folds upstream
    // detections/ocr; the mock returns no new signal, just believable timing.
    default:
      response = { ...base, raw: { task, note: "aggregation handled by execution engine" } };
  }

  // Contract-faithfulness is the whole promise of module 13: never emit a response
  // that wouldn't validate against the shared schema the real module 06 returns.
  return InferenceResponseSchema.parse(response) as InferenceResponse;
}

/** Best-effort task inference from the catalog's modelId naming, as a fallback. */
function inferTaskFromModel(modelId: string): string {
  if (modelId.startsWith("yolo")) return "object_detection";
  if (modelId.startsWith("vehicle-cls")) return "vehicle_classification";
  if (modelId.startsWith("color-net")) return "color_classification";
  if (modelId.startsWith("anpr")) return "anpr_ocr";
  if (modelId === "counter") return "counting";
  if (modelId.startsWith("bytetrack") || modelId.startsWith("track")) return "tracking";
  if (modelId.startsWith("embed")) return "embedding";
  if (modelId === "matcher") return "match_filtering";
  if (modelId.startsWith("nsfw")) return "nsfw";
  return "object_detection";
}
