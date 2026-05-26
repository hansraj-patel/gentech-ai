/**
 * Zod schemas mirroring requirements/00-shared-contracts.md.
 * Zod is the single source of truth; TS types are inferred via z.infer.
 * Only the slice the agentic layer (module 03) touches is modeled here:
 * §1 identity, §4 query/pipeline, §5 (ModelMetadata only), §6 compute/cost, §7 error.
 */
import { z } from "zod";

// ── §0 primitives ────────────────────────────────────────────────────────────
export const Timestamp = z.string().datetime({ offset: true }); // RFC-3339 UTC
const Id = z.string().min(1);

// ── §1 Identity & Tenancy ─────────────────────────────────────────────────────
export const AuthContextSchema = z.object({
  tenantId: Id,
  userId: Id,
  roles: z.array(z.string()),
  scopes: z.array(z.string()),
  attrs: z.record(z.string(), z.string()),
  budgetRef: Id.optional(),
});

// ── §4 Query, Pipeline & Jobs ───────────────────────────────────────────────
export const QualityTierSchema = z.enum(["low", "standard", "high"]);

export const QueryConstraintsSchema = z.object({
  maxCredits: z.number().int().nonnegative().optional(),
  maxLatencyMs: z.number().positive().optional(),
  minQuality: QualityTierSchema.optional(),
});

export const QuerySchema = z.object({
  queryId: Id,
  tenantId: Id,
  text: z.string().min(1),
  sources: z.array(Id),
  timeWindow: z.object({ from: Timestamp, to: Timestamp }).optional(),
  constraints: QueryConstraintsSchema.optional(),
});

export const ComputeRequestSchema = z.object({
  gpuClass: z.enum(["none", "small", "medium", "large"]).optional(),
  minVramGb: z.number().nonnegative().optional(),
  estDurationSec: z.number().nonnegative().optional(),
  priority: z.number().int().min(0).max(9),
});

export const PipelineNodeSchema = z.object({
  nodeId: Id,
  task: z.string().min(1),
  modelId: Id,
  params: z.record(z.string(), z.unknown()),
  compute: ComputeRequestSchema,
  parallelizable: z.boolean(),
});

export const EdgeSchema = z.object({ from: Id, to: Id });

export const RetryPolicySchema = z.object({
  maxRetries: z.number().int().nonnegative(),
  backoff: z.enum(["fixed", "exponential"]),
  deadLetter: z.boolean(),
});

export const PipelineSpecSchema = z.object({
  pipelineId: Id,
  queryId: Id,
  tenantId: Id,
  nodes: z.array(PipelineNodeSchema).min(1),
  edges: z.array(EdgeSchema),
  explanation: z.string().optional(),
  retryPolicy: RetryPolicySchema,
});

// ── §2 Media (CompressionPlan — produced by orchestrator FR-6) ────────────────
export const CompressionPlanSchema = z.object({
  decidedBy: z.enum(["agent", "user"]),
  targetResolution: z.string(),
  targetBitrateKbps: z.number().positive(),
  targetFps: z.number().positive(),
  rationale: z.string().optional(),
});

// ── §5 model registry metadata (module 06) ───────────────────────────────────
export const ModelMetadataSchema = z.object({
  modelId: Id,
  task: z.string().min(1),
  qualityTier: QualityTierSchema,
  gpuClass: z.enum(["none", "small", "medium", "large"]),
  minVramGb: z.number().nonnegative(),
  latencyMsEst: z.number().positive(),
  costWeight: z.number().positive(),
  capabilities: z.array(z.string()),
});

// ── §6 Cost ───────────────────────────────────────────────────────────────────
export const CostEstimateSchema = z.object({
  pipelineId: Id,
  credits: z.number().int().nonnegative(),
  breakdown: z.array(z.object({ item: z.string(), credits: z.number().int().nonnegative() })),
  runtimeSecEst: z.number().nonnegative(),
  gpuClassEst: z.string(),
  confidence: z.enum(["low", "medium", "high"]),
});

export const BudgetPolicySchema = z.object({
  budgetRef: Id,
  tenantId: Id,
  scope: z.enum(["tenant", "team", "user"]),
  capCredits: z.number().int().nonnegative(),
  period: z.enum(["daily", "monthly", "none"]),
  spent: z.number().int().nonnegative(),
  emergencyCutoff: z.boolean(),
});

// ── §7 Error ──────────────────────────────────────────────────────────────────
export const ErrorSchema = z.object({
  code: z.string(),
  module: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.unknown().optional(),
});
