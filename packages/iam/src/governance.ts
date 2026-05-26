import type { AuthContext } from "@gentech/contracts";
import type { AuthDecision, ComputeGovernance } from "./types.js";

const DEFAULT_PRIORITY = 5; // matches the orchestrator stub's mid-priority

/** Default per-tenant governance envelope; real deployments load this per tenant. */
export function defaultGovernance(tenantId: string): ComputeGovernance {
  return {
    tenantId,
    perUserMaxConcurrentJobs: 5,
    teamQuotas: [],
    priorityRights: [
      { role: "viewer", maxPriority: 3 },
      { role: "analyst", maxPriority: 5 },
      { role: "operator", maxPriority: 7 },
      { role: "tenant_admin", maxPriority: 9 },
    ],
    isolation: { dedicatedGpuPool: false, perTenantQueue: true, namespace: tenantId },
  };
}

/** Highest scheduler priority (0–9) the principal's roles entitle them to. */
export function priorityFor(
  auth: AuthContext,
  gov: ComputeGovernance = defaultGovernance(auth.tenantId),
): number {
  const rights = gov.priorityRights
    .filter((p) => auth.roles.includes(p.role))
    .map((p) => p.maxPriority);
  const p = rights.length ? Math.max(...rights) : DEFAULT_PRIORITY;
  return Math.min(9, Math.max(0, p));
}

export interface QuotaAsk {
  concurrentJobs?: number;
  team?: string;
  credits?: number;
}

/** Compute-governance gate (FR-5): per-user concurrency + per-team credit quotas. */
export function checkQuota(
  auth: AuthContext,
  ask: QuotaAsk,
  gov: ComputeGovernance = defaultGovernance(auth.tenantId),
): AuthDecision {
  if (ask.concurrentJobs !== undefined && ask.concurrentJobs > gov.perUserMaxConcurrentJobs) {
    return {
      allow: false,
      reason: `concurrent jobs ${ask.concurrentJobs} exceeds limit ${gov.perUserMaxConcurrentJobs}`,
    };
  }
  if (ask.team !== undefined && ask.credits !== undefined) {
    const quota = gov.teamQuotas.find((q) => q.team === ask.team);
    if (quota && ask.credits > quota.maxCredits) {
      return {
        allow: false,
        reason: `team ${ask.team} credits ${ask.credits} exceeds quota ${quota.maxCredits}`,
      };
    }
  }
  return { allow: true };
}
