/**
 * Owned contract types for module 09 (content safety & query validation). Kept
 * LOCAL to this package to avoid editing the shared contract files. ValidationVerdict
 * mirrors the orchestrator's stub shape so it is a drop-in replacement.
 */
import { z } from "zod";

export const SafetyPolicySchema = z.object({
  tenantId: z.string(),
  /** Categories whose mention blocks a query / whose content is blocked. */
  blockedCategories: z.array(z.string()),
  /** Capabilities disabled by default (privacy), e.g. face recognition. */
  restrictedCapabilities: z.array(z.string()),
  /** Optional allow-list of tasks; when set, anything outside it is blocked. */
  allowedTasks: z.array(z.string()).optional(),
});
export type SafetyPolicy = z.infer<typeof SafetyPolicySchema>;

export const ValidationVerdictSchema = z.object({
  queryId: z.string(),
  allow: z.boolean(),
  reasons: z.array(z.object({ code: z.string(), message: z.string() })),
  requiredScopesMissing: z.array(z.string()).optional(),
  redactions: z.array(z.string()).optional(),
});
export type ValidationVerdict = z.infer<typeof ValidationVerdictSchema>;

export const SafetyVerdictSchema = z.object({
  segmentId: z.string().optional(),
  category: z.enum(["safe", "nsfw", "restricted"]),
  score: z.number().min(0).max(1),
  action: z.enum(["allow", "blur", "block"]),
});
export type SafetyVerdict = z.infer<typeof SafetyVerdictSchema>;
