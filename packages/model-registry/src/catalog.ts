import { ModelMetadataSchema, type ModelMetadata } from "@gentech/contracts";

/**
 * Module 06 — the real model catalog (metadata only; inference itself is mocked
 * by module 13 later). Every capability the source-doc example queries need is
 * covered at multiple quality/cost tiers so the resolver has something to choose.
 *
 * `task` is the capability id from the orchestrator's ontology. `costWeight` is a
 * relative multiplier consumed by module 11's cost math. CPU-only paths use
 * gpuClass "none".
 */
const RAW: ModelMetadata[] = [
  // ── object detection ───────────────────────────────────────────────────────
  m("yolo-n", "object_detection", "low", "small", 2, 8, 1.0),
  m("yolo-s", "object_detection", "standard", "small", 4, 15, 2.0),
  m("yolo-m", "object_detection", "high", "medium", 8, 35, 4.0),

  // ── vehicle classification ──────────────────────────────────────────────────
  m("vehicle-cls-lite", "vehicle_classification", "standard", "small", 2, 6, 1.0),
  m("vehicle-cls-pro", "vehicle_classification", "high", "medium", 6, 20, 3.0),

  // ── color classification ────────────────────────────────────────────────────
  m("color-net", "color_classification", "standard", "none", 0, 4, 0.5),
  m("color-net-hi", "color_classification", "high", "small", 2, 10, 1.5),

  // ── counting (pure aggregation, CPU) ─────────────────────────────────────────
  m("counter", "counting", "standard", "none", 0, 1, 0.1),

  // ── ANPR / OCR ────────────────────────────────────────────────────────────────
  m("anpr-lite", "anpr_ocr", "standard", "small", 4, 25, 3.0),
  m("anpr-pro", "anpr_ocr", "high", "medium", 8, 60, 6.0),

  // ── multi-object tracking ───────────────────────────────────────────────────
  m("bytetrack", "tracking", "standard", "small", 3, 12, 2.0),
  m("track-pro", "tracking", "high", "medium", 6, 30, 4.0),

  // ── embeddings ──────────────────────────────────────────────────────────────
  m("embed-base", "embedding", "standard", "small", 4, 18, 2.5),
  m("embed-large", "embedding", "high", "medium", 8, 40, 5.0),

  // ── match filtering (compares attrs/embeddings to a target, CPU) ─────────────
  m("matcher", "match_filtering", "standard", "none", 0, 2, 0.2),

  // ── NSFW / moderation ────────────────────────────────────────────────────────
  m("nsfw-guard", "nsfw", "standard", "small", 2, 8, 1.0),
];

function m(
  modelId: string,
  task: string,
  qualityTier: ModelMetadata["qualityTier"],
  gpuClass: ModelMetadata["gpuClass"],
  minVramGb: number,
  latencyMsEst: number,
  costWeight: number,
): ModelMetadata {
  return ModelMetadataSchema.parse({
    modelId,
    task,
    qualityTier,
    gpuClass,
    minVramGb,
    latencyMsEst,
    costWeight,
    capabilities: [task],
  });
}

export const CATALOG: readonly ModelMetadata[] = Object.freeze(RAW);
