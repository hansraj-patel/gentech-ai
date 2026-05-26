/**
 * Preset catalog (module 07, FR-1). Each `PresetDefinition` is a ready-made
 * analytics workflow expressed as a natural-language `objective` template plus
 * default parameters, a default time-window, and default alert rules. The
 * objective is materialized into the very same `PipelineSpec` the orchestrator
 * (module 03) emits, so execution (module 04) reuses the run path unchanged.
 *
 * Owned local types stay in this package; zod is the single source of truth and
 * TS types are inferred via z.infer (house style).
 */
import { z } from "zod";
import { AlertRuleSchema, type AlertRule } from "./alerts.js";

/** The five shipped preset categories (FR-1). */
export const PresetCategory = z.enum([
  "intrusion_detection",
  "vehicle_counting",
  "queue_monitoring",
  "license_plate_scan",
  "crowd_analytics",
]);
export type PresetCategory = z.infer<typeof PresetCategory>;

export const PresetDefinitionSchema = z.object({
  presetId: PresetCategory,
  name: z.string().min(1),
  /**
   * A natural-language objective template. `${param}` placeholders are
   * interpolated from `defaultParams` (and caller overrides) at materialize-time,
   * then handed to the orchestrator's `buildQuery` as the query text.
   */
  objective: z.string().min(1),
  defaultParams: z.record(z.string(), z.unknown()),
  defaultWindowSec: z.number().int().positive(),
  defaultAlertRules: z.array(AlertRuleSchema),
});
export type PresetDefinition = z.infer<typeof PresetDefinitionSchema>;

/** Interpolate `${name}` placeholders in a template against a params bag. */
export function fillTemplate(template: string, params: Record<string, unknown>): string {
  return template.replace(/\$\{(\w+)\}/g, (_m, key: string) => {
    const v = params[key];
    return v === undefined || v === null ? "" : String(v);
  }).replace(/\s+/g, " ").trim();
}

function rule(
  ruleId: string,
  metric: string,
  op: AlertRule["op"],
  threshold: number,
  windowSec: number,
): AlertRule {
  return AlertRuleSchema.parse({ ruleId, metric, op, threshold, windowSec });
}

/** The shipped catalog of 5 presets (FR-1). */
export const PRESETS: Readonly<Record<PresetCategory, PresetDefinition>> = Object.freeze({
  intrusion_detection: PresetDefinitionSchema.parse({
    presetId: "intrusion_detection",
    name: "Intrusion Detection",
    objective: "detect people entering ${zone} and count intrusions",
    defaultParams: { zone: "the restricted area", classes: ["person"] },
    defaultWindowSec: 30,
    defaultAlertRules: [rule("intrusion_any", "count", ">=", 1, 30)],
  }),
  vehicle_counting: PresetDefinitionSchema.parse({
    presetId: "vehicle_counting",
    name: "Vehicle Counting",
    objective: "count how many ${color} vehicles pass through ${zone}",
    defaultParams: { color: "", zone: "the lane" },
    defaultWindowSec: 60,
    defaultAlertRules: [rule("vehicle_surge", "count", ">", 100, 60)],
  }),
  queue_monitoring: PresetDefinitionSchema.parse({
    presetId: "queue_monitoring",
    name: "Queue Monitoring",
    objective: "monitor the number of people waiting in ${zone} and report queue length",
    defaultParams: { zone: "the checkout queue", classes: ["person"] },
    defaultWindowSec: 30,
    defaultAlertRules: [rule("queue_too_long", "count", ">=", 10, 30)],
  }),
  license_plate_scan: PresetDefinitionSchema.parse({
    presetId: "license_plate_scan",
    name: "License Plate Scan (ANPR)",
    objective: "read the license plate of every vehicle in ${zone} and match against ${watchlist}",
    defaultParams: { zone: "the entry gate", watchlist: "the watchlist" },
    defaultWindowSec: 60,
    defaultAlertRules: [rule("plate_match", "matches", ">=", 1, 60)],
  }),
  crowd_analytics: PresetDefinitionSchema.parse({
    presetId: "crowd_analytics",
    name: "Crowd Analytics",
    objective: "count people and estimate crowd density in ${zone}",
    defaultParams: { zone: "the plaza", classes: ["person"] },
    defaultWindowSec: 60,
    defaultAlertRules: [rule("crowd_capacity", "count", ">", 500, 60)],
  }),
});

/** List every shipped preset (catalog for `GET /presets`). */
export function listPresets(): PresetDefinition[] {
  return Object.values(PRESETS);
}

/** Fetch a single preset by id, or throw if unknown. */
export function getPreset(id: string): PresetDefinition {
  const parsed = PresetCategory.safeParse(id);
  if (!parsed.success) {
    throw new Error(`unknown presetId: ${id}`);
  }
  return PRESETS[parsed.data];
}
