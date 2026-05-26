/** Inferred TS types — one source (the zod schemas), no hand-maintained duplicates. */
import type { z } from "zod";
import type {
  AuthContextSchema,
  QuerySchema,
  QueryConstraintsSchema,
  ComputeRequestSchema,
  PipelineNodeSchema,
  EdgeSchema,
  RetryPolicySchema,
  PipelineSpecSchema,
  CompressionPlanSchema,
  ModelMetadataSchema,
  CostEstimateSchema,
  BudgetPolicySchema,
  ErrorSchema,
} from "./schemas.js";

export type AuthContext = z.infer<typeof AuthContextSchema>;
export type Query = z.infer<typeof QuerySchema>;
export type QueryConstraints = z.infer<typeof QueryConstraintsSchema>;
export type ComputeRequest = z.infer<typeof ComputeRequestSchema>;
export type PipelineNode = z.infer<typeof PipelineNodeSchema>;
export type Edge = z.infer<typeof EdgeSchema>;
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;
export type PipelineSpec = z.infer<typeof PipelineSpecSchema>;
export type CompressionPlan = z.infer<typeof CompressionPlanSchema>;
export type ModelMetadata = z.infer<typeof ModelMetadataSchema>;
export type CostEstimate = z.infer<typeof CostEstimateSchema>;
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;
export type GenTechError = z.infer<typeof ErrorSchema>;

export type GpuClass = "none" | "small" | "medium" | "large";
export type QualityTier = "low" | "standard" | "high";
