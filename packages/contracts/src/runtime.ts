/**
 * Runtime schemas — the execution-plane slice of 00-shared-contracts.md that the
 * pipeline engine (module 04) and mock server (module 13) need: inference I/O,
 * results, media segments, job status, compute leases/inventory, usage, and the
 * event envelope. Kept in a separate file from `schemas.ts` (the orchestrator
 * slice) so the two halves evolve without colliding.
 *
 * As everywhere in this package, zod is the single source of truth and TS types
 * are inferred via z.infer — no hand-maintained duplicates.
 */
import { z } from "zod";
import { Timestamp } from "./schemas.js";

const Id = z.string().min(1);

// ── §5 Inference & Results ────────────────────────────────────────────────────
export const BBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
}); // normalized 0..1

export const DetectionSchema = z.object({
  label: z.string(),
  confidence: z.number().min(0).max(1),
  bbox: BBoxSchema,
  attrs: z.record(z.string(), z.string()).optional(), // e.g. {color:"white"}
});

export const TrackSchema = z.object({
  trackId: z.string(),
  label: z.string(),
  points: z.array(z.object({ t: z.number(), bbox: BBoxSchema })),
});

export const InferenceRequestSchema = z.object({
  requestId: Id,
  jobId: Id,
  nodeId: Id,
  modelId: Id,
  segment: z.object({ segmentId: Id, storageRef: z.string() }),
  params: z.record(z.string(), z.unknown()),
});

export const InferenceResponseSchema = z.object({
  requestId: Id,
  modelId: Id,
  latencyMs: z.number().nonnegative(),
  detections: z.array(DetectionSchema).optional(),
  tracks: z.array(TrackSchema).optional(),
  embeddings: z.array(z.array(z.number())).optional(),
  ocr: z
    .array(z.object({ text: z.string(), confidence: z.number().min(0).max(1), bbox: BBoxSchema }))
    .optional(),
  nsfwScore: z.number().min(0).max(1).optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
});

export const ResultKind = z.enum([
  "count",
  "timeseries",
  "detections",
  "tracks",
  "match",
  "heatmap",
  "summary",
  "table",
]);

export const ResultEventSchema = z.object({
  resultId: Id,
  jobId: Id,
  tenantId: Id,
  kind: ResultKind,
  partial: z.boolean(), // true while job still running (progressive)
  payload: z.unknown(), // shape depends on `kind` (see module 08)
  ts: Timestamp,
});

// ── §2 Media ──────────────────────────────────────────────────────────────────
export const MediaSegmentSchema = z.object({
  segmentId: Id,
  sourceId: Id,
  tenantId: Id,
  index: z.number().int().nonnegative(), // monotonic per source
  tStart: z.number().nonnegative(),
  tEnd: z.number().nonnegative(),
  storageRef: z.string(), // opaque pointer to bytes; NOT the bytes
  codec: z.string(),
  final: z.boolean(), // last segment of a finite upload
});

// ── §4 Jobs ─────────────────────────────────────────────────────────────────
export const JobState = z.enum([
  "queued",
  "running",
  "partial",
  "succeeded",
  "failed",
  "cancelled",
  "degraded",
]);
export const NodeState = z.enum(["pending", "running", "done", "failed", "skipped"]);

export const JobStatusSchema = z.object({
  jobId: Id,
  pipelineId: Id,
  tenantId: Id,
  state: JobState,
  nodeStates: z.record(z.string(), NodeState),
  progress: z.number().min(0).max(1),
  startedAt: Timestamp.optional(),
  endedAt: Timestamp.optional(),
  costSoFar: z.number().int().nonnegative(), // credits
});

// ── §6 Compute & Resources ────────────────────────────────────────────────────
export const WorkerLeaseSchema = z.object({
  leaseId: Id,
  jobId: Id,
  nodeId: Id.optional(),
  gpuClass: z.string(),
  vramGb: z.number().nonnegative(),
  cpuOnly: z.boolean(),
  grantedAt: Timestamp,
  expiresAt: Timestamp,
  endpoint: z.string().optional(), // where to send work (mock or real worker)
});

export const GpuInventorySchema = z.object({
  total: z.record(z.string(), z.number().int().nonnegative()),
  available: z.record(z.string(), z.number().int().nonnegative()),
  runningJobs: z.number().int().nonnegative(),
  queueDepth: z.number().int().nonnegative(),
  updatedAt: Timestamp,
});

export const UsageEventSchema = z.object({
  usageId: Id,
  tenantId: Id,
  jobId: Id,
  gpuSeconds: z.number().nonnegative(),
  gpuClass: z.string(),
  storageGbHours: z.number().nonnegative().optional(),
  bandwidthGb: z.number().nonnegative().optional(),
  ts: Timestamp,
});

// ── §7 Event envelope ─────────────────────────────────────────────────────────
/** Build an `Event<T>` schema around a typed payload (§7). */
export function makeEventSchema<T extends z.ZodTypeAny>(payload: T) {
  return z.object({
    eventId: Id,
    type: z.string(),
    tenantId: Id,
    jobId: Id.optional(),
    ts: Timestamp,
    traceId: Id,
    payload,
  });
}
/** Generic envelope with an unknown payload (for heterogeneous sinks/buses). */
export const EventSchema = makeEventSchema(z.unknown());

// ── inferred TS types ─────────────────────────────────────────────────────────
export type BBox = z.infer<typeof BBoxSchema>;
export type Detection = z.infer<typeof DetectionSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type InferenceRequest = z.infer<typeof InferenceRequestSchema>;
export type InferenceResponse = z.infer<typeof InferenceResponseSchema>;
export type ResultEvent = z.infer<typeof ResultEventSchema>;
export type MediaSegment = z.infer<typeof MediaSegmentSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type WorkerLease = z.infer<typeof WorkerLeaseSchema>;
export type GpuInventory = z.infer<typeof GpuInventorySchema>;
export type UsageEvent = z.infer<typeof UsageEventSchema>;
export type Event<T = unknown> = Omit<z.infer<typeof EventSchema>, "payload"> & { payload: T };
