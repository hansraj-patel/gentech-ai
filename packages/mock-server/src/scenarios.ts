/**
 * Scenarios = the deterministic "ground truth" the mock derives its outputs from
 * (module 13, §5 + FR-2). Because outputs come from ground truth, a demo query like
 * "how many white cars" returns the scenario's *intended* answer — coherent, not
 * random noise.
 *
 * Fixtures are authored as TS modules under ./scenarios/ (validated against
 * ScenarioSchema at load). TS over raw JSON so they're type-checked and ship in the
 * build without a copy step; still hand-editable. (Open decision JSON-vs-YAML in the
 * spec — TS wins here for the monorepo.)
 */
import { z } from "zod";

/** One distinct object instance present in the scene at a specific segment. */
export const GtObjectSchema = z.object({
  id: z.string(), // stable identity → engine dedups counts by this
  label: z.string(), // "car","truck","person",...
  atSegment: z.number().int().nonnegative(),
  attrs: z.record(z.string(), z.string()).default({}), // {color:"white","type":"sedan"}
});

export const GtTrackSchema = z.object({
  trackId: z.string(),
  label: z.string(),
  segments: z.array(z.number().int().nonnegative()), // segments the track spans
});

export const GtAnprSchema = z.object({ plate: z.string(), atSegment: z.number().int().nonnegative() });

export const GtEventSchema = z.object({
  kind: z.string(), // "intrusion","loitering",...
  atTime: z.number().nonnegative(), // simulated-clock time the event fires
});

export const ScenarioSchema = z.object({
  scenarioId: z.string(),
  name: z.string(),
  segmentCount: z.number().int().positive(), // how many segments a full run produces
  sources: z.array(z.object({ sourceId: z.string(), profile: z.string() })),
  groundTruth: z.object({
    objects: z.array(GtObjectSchema).default([]),
    tracks: z.array(GtTrackSchema).default([]),
    anpr: z.array(GtAnprSchema).default([]),
    events: z.array(GtEventSchema).default([]),
    nsfwScore: z.number().min(0).max(1).default(0.02),
  }),
  infra: z.object({
    gpuTotals: z.record(z.string(), z.number().int().nonnegative()),
    loadProfile: z.enum(["steady", "bursty", "scarce"]),
  }),
});

export type Scenario = z.infer<typeof ScenarioSchema>;

import { parkingLotDaytime } from "./scenarios/parking-lot-daytime.js";
import { gateIntrusionNight } from "./scenarios/gate-intrusion-night.js";

const REGISTRY: Map<string, Scenario> = new Map(
  [parkingLotDaytime, gateIntrusionNight]
    .map((raw) => ScenarioSchema.parse(raw)) // fail loud on a malformed fixture
    .map((s) => [s.scenarioId, s] as const),
);

export function listScenarios(): Scenario[] {
  return [...REGISTRY.values()];
}

export function getScenario(scenarioId: string): Scenario {
  const s = REGISTRY.get(scenarioId);
  if (!s) throw new Error(`unknown scenario "${scenarioId}" (have: ${[...REGISTRY.keys()].join(", ")})`);
  return s;
}
