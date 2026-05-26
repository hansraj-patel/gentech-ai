import { z } from "zod";

/**
 * The fixed v1 capability ontology — the closed vocabulary the LLM may plan with
 * (FR-1). Keeping it closed is what makes the plan validatable and the resolver's
 * task→model mapping total. Adding a capability = editing this file (and adding a
 * model in module 06 that serves it).
 */
export interface Capability {
  /** Capability id == ModelMetadata.task in the registry. */
  task: string;
  description: string;
  /** Zod schema for this capability's params (lenient: all optional, extras allowed). */
  paramsSchema: z.ZodType;
  /** Tasks that may legally feed into this one (for plan sanity hints, not hard-enforced). */
  consumes: string[];
}

const lenient = (shape: z.ZodRawShape) => z.object(shape).passthrough();

export const CAPABILITIES: Record<string, Capability> = {
  object_detection: {
    task: "object_detection",
    description: "Detect objects in frames; params.classes filters to specific labels (e.g. ['car']).",
    paramsSchema: lenient({ classes: z.array(z.string()).optional() }),
    consumes: [],
  },
  vehicle_classification: {
    task: "vehicle_classification",
    description: "Classify detected vehicles by type (car/truck/bus/...).",
    paramsSchema: lenient({}),
    consumes: ["object_detection"],
  },
  color_classification: {
    task: "color_classification",
    description: "Classify object color; params.color filters to a target color (e.g. 'white').",
    paramsSchema: lenient({ color: z.string().optional() }),
    consumes: ["object_detection", "vehicle_classification"],
  },
  counting: {
    task: "counting",
    description: "Aggregate/count upstream detections matching the criteria. Terminal in count queries.",
    paramsSchema: lenient({ of: z.string().optional() }),
    consumes: ["object_detection", "vehicle_classification", "color_classification"],
  },
  anpr_ocr: {
    task: "anpr_ocr",
    description: "Read license plates / text from detected regions.",
    paramsSchema: lenient({}),
    consumes: ["object_detection"],
  },
  tracking: {
    task: "tracking",
    description: "Track objects across frames over time (multi-object tracking).",
    paramsSchema: lenient({}),
    consumes: ["object_detection", "anpr_ocr"],
  },
  embedding: {
    task: "embedding",
    description: "Compute appearance embeddings for re-identification / similarity search.",
    paramsSchema: lenient({}),
    consumes: ["object_detection", "tracking"],
  },
  match_filtering: {
    task: "match_filtering",
    description: "Filter/match upstream outputs against a target (plate string, embedding, attributes).",
    paramsSchema: lenient({ target: z.string().optional() }),
    consumes: ["anpr_ocr", "tracking", "embedding"],
  },
  nsfw: {
    task: "nsfw",
    description: "Score frames for unsafe/restricted content (moderation gate).",
    paramsSchema: lenient({}),
    consumes: [],
  },
};

export const CAPABILITY_TASKS = Object.keys(CAPABILITIES);

export function isKnownTask(task: string): boolean {
  return task in CAPABILITIES;
}

/** Compact text summary of the ontology for the LLM system prompt. */
export function ontologySummary(): string {
  return Object.values(CAPABILITIES)
    .map((c) => `- ${c.task}: ${c.description}`)
    .join("\n");
}
