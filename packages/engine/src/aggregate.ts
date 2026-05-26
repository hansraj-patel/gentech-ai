/**
 * Aggregation (module 04): fold per-node, per-segment InferenceResponses into the
 * typed ResultEvents the UI renders. The query *shape* (derived from the spec's node
 * tasks) decides the result kind:
 *   counting → count, match_filtering → match, tracking → tracks, else → detections.
 *
 * Dedup is by stable ground-truth id (the mock stamps `attrs.id`), which is what
 * makes counts exactly-once across the detect→classify→color chain and across
 * retries — the same physical object seen by several nodes is counted once.
 */
import type {
  Detection,
  InferenceResponse,
  PipelineSpec,
  ResultEvent,
  Track,
} from "@gentech/contracts";
import { newResultId } from "./ids.js";

export interface DerivedFilters {
  classes?: string[];
  color?: string;
}

/** Pull the analytic filters the orchestrator encoded into the node params. */
export function deriveFilters(spec: PipelineSpec): DerivedFilters {
  const f: DerivedFilters = {};
  for (const n of spec.nodes) {
    if (n.task === "object_detection" && Array.isArray(n.params.classes)) {
      const classes = (n.params.classes as unknown[]).map(String).filter(Boolean);
      if (classes.length) f.classes = classes;
    }
    if (n.task === "color_classification" && typeof n.params.color === "string") {
      f.color = n.params.color;
    }
  }
  return f;
}

export type ResultKind = ResultEvent["kind"];

export function determineKind(spec: PipelineSpec): ResultKind {
  const tasks = new Set(spec.nodes.map((n) => n.task));
  if (tasks.has("match_filtering")) return "match";
  if (tasks.has("counting")) return "count";
  if (tasks.has("tracking")) return "tracks";
  return "detections";
}

function dedupDetections(responses: InferenceResponse[]): Detection[] {
  const byId = new Map<string, Detection>();
  let anon = 0;
  for (const r of responses) {
    for (const d of r.detections ?? []) {
      const id = d.attrs?.id ?? `anon_${anon++}`;
      if (!byId.has(id)) byId.set(id, d);
    }
  }
  return [...byId.values()];
}

function matchesFilters(d: Detection, f: DerivedFilters): boolean {
  if (f.classes && !f.classes.includes(d.label)) return false;
  if (f.color && d.attrs?.color !== f.color) return false;
  return true;
}

interface AggregateArgs {
  spec: PipelineSpec;
  responses: InferenceResponse[];
  jobId: string;
  tenantId: string;
  partial: boolean;
  now: () => string;
}

/** Build the ResultEvent(s) for the current checkpoint state. */
export function aggregate(args: AggregateArgs): ResultEvent[] {
  const { spec, responses, jobId, tenantId, partial, now } = args;
  const kind = determineKind(spec);
  const base = { resultId: newResultId(), jobId, tenantId, partial, ts: now() };

  if (kind === "match") {
    const target = matchTarget(spec);
    const occurrences = responses
      .flatMap((r) => r.ocr ?? [])
      .filter((o) => (target ? normalizePlate(o.text).includes(normalizePlate(target)) : true))
      .map((o) => ({ text: o.text, confidence: o.confidence }));
    return [
      { ...base, kind, payload: { target: target ?? null, matched: occurrences.length > 0, occurrences, count: occurrences.length } },
    ];
  }

  if (kind === "count") {
    const filters = deriveFilters(spec);
    const matching = dedupDetections(responses).filter((d) => matchesFilters(d, filters));
    return [
      { ...base, kind, payload: { count: matching.length, label: filters.classes?.[0] ?? null, color: filters.color ?? null, filters } },
    ];
  }

  if (kind === "tracks") {
    const byTrack = new Map<string, Track>();
    for (const r of responses) for (const t of r.tracks ?? []) byTrack.set(t.trackId, t);
    const tracks = [...byTrack.values()];
    return [{ ...base, kind, payload: { tracks, count: tracks.length } }];
  }

  const detections = dedupDetections(responses);
  return [{ ...base, kind, payload: { detections, count: detections.length } }];
}

function matchTarget(spec: PipelineSpec): string | undefined {
  const node = spec.nodes.find((n) => n.task === "match_filtering");
  const t = node?.params.target;
  return typeof t === "string" ? t : undefined;
}

const normalizePlate = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
