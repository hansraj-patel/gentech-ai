/**
 * Owned contract types for module 10 (IAM/governance). Kept LOCAL to this package
 * (not in @gentech/contracts) so this build never edits the shared contract files
 * the execution-plane agent is concurrently changing. Promote to shared later.
 * Zod is the single source of truth; TS types are inferred via z.infer.
 */
import { z } from "zod";

export const RoleSchema = z.object({
  name: z.string(),
  /** Scope patterns this role grants, e.g. "query:run", "camera:read:*", "*". */
  permissions: z.array(z.string()),
});
export type Role = z.infer<typeof RoleSchema>;

export const PolicyRuleSchema = z.object({
  effect: z.enum(["allow", "deny"]),
  action: z.string(),
  resource: z.string(),
  /** ABAC predicate: every entry must equal the matching AuthContext.attrs key. */
  when: z.record(z.string(), z.string()).optional(),
});
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;

export const ComputeGovernanceSchema = z.object({
  tenantId: z.string(),
  perUserMaxConcurrentJobs: z.number().int().nonnegative(),
  teamQuotas: z.array(z.object({ team: z.string(), maxCredits: z.number().int().nonnegative() })),
  priorityRights: z.array(z.object({ role: z.string(), maxPriority: z.number().int().min(0).max(9) })),
  isolation: z.object({
    dedicatedGpuPool: z.boolean(),
    perTenantQueue: z.boolean(),
    namespace: z.string(),
  }),
});
export type ComputeGovernance = z.infer<typeof ComputeGovernanceSchema>;

export interface AuthDecision {
  allow: boolean;
  reason?: string;
}
