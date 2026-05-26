import type { BudgetPolicy } from "@gentech/contracts";

export interface BudgetDecision {
  allow: boolean;
  reason?: string;
}

/**
 * Module 11 — budget gate. Compares an estimate against the active policy's cap
 * and emergency cutoff. Used by the orchestrator's degradation loop (FR-8) and as
 * the pre-run check (acceptance criteria).
 */
export function checkBudget(
  estimatedCredits: number,
  budget: BudgetPolicy | undefined,
): BudgetDecision {
  if (!budget) return { allow: true };
  const projected = budget.spent + estimatedCredits;
  if (budget.emergencyCutoff && budget.spent >= budget.capCredits) {
    return { allow: false, reason: "emergency cutoff: budget already exhausted" };
  }
  if (projected > budget.capCredits) {
    return {
      allow: false,
      reason: `estimate ${estimatedCredits} would exceed cap ${budget.capCredits} (spent ${budget.spent})`,
    };
  }
  return { allow: true };
}
