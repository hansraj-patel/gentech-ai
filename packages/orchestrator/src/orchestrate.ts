import {
  ContractError,
  makeId,
  type AuthContext,
  type BudgetPolicy,
  type CostEstimate,
  type PipelineSpec,
  type Query,
} from "@gentech/contracts";
import { defaultRegistry, type ModelRegistry } from "@gentech/model-registry";
import { checkBudget, estimate } from "@gentech/cost";
import { validateCapabilityPlan, type CapabilityPlan, type Planner } from "./plan.js";
import { RuleBasedPlanner } from "./planners/rules.js";
import { resolve } from "./resolve.js";
import {
  InProcessEventBus,
  priorityFor,
  resolveAuth,
  validateQuery,
} from "./stubs.js";

export interface OrchestrateOptions {
  /** Primary planner (LLM). Required — pass AnthropicPlanner or a mock. */
  planner: Planner;
  registry?: ModelRegistry;
  auth?: AuthContext;
  /** Active budget envelope; degradation/blocking is evaluated against it. */
  budget?: BudgetPolicy;
  /** Fallback when the primary planner keeps emitting invalid plans. */
  fallbackPlanner?: Planner;
  maxRepairs?: number;
  bus?: InProcessEventBus;
  traceId?: string;
}

export interface OrchestrateResult {
  pipeline: PipelineSpec;
  cost: CostEstimate;
  /** True if the budget forced a cheaper (degraded) pipeline (FR-8). */
  degraded: boolean;
  plannerUsed: string;
  traceId: string;
}

/**
 * Module 03 entrypoint. Two real stages — LLM plans the capability DAG, a
 * deterministic resolver picks models — wrapped with a repair loop, a fail-safe
 * fallback, real cost estimation, and budget-driven degradation (FR-1..FR-8).
 */
export async function orchestrate(
  query: Query,
  opts: OrchestrateOptions,
): Promise<OrchestrateResult> {
  const registry = opts.registry ?? defaultRegistry;
  const auth = opts.auth ?? resolveAuth({ tenantId: query.tenantId });
  const bus = opts.bus ?? new InProcessEventBus();
  const traceId = opts.traceId ?? makeId("PipelineId").replace("pipe_", "trace_");
  const maxRepairs = opts.maxRepairs ?? 2;

  // ── module 09 gate (stubbed) ────────────────────────────────────────────────
  const verdict = validateQuery(query, auth);
  if (!verdict.allow) {
    throw new ContractError({
      code: "VALIDATION_FAILED",
      module: "orchestrator",
      message: "query rejected by validation",
      retryable: false,
      details: verdict.reasons,
    });
  }

  // ── stage 1: plan (with repair loop + fallback) ──────────────────────────────
  const { plan, plannerUsed } = await planWithRepair(query, opts, maxRepairs);

  // ── stage 2: resolve, estimate, and degrade to fit budget ─────────────────────
  const priority = priorityFor(auth);
  let pipeline = resolve(plan, query, auth, registry, { honorQualityFloor: true, priority });
  let cost = estimate(pipeline, registry);
  let degraded = false;

  if (overBudget(cost.credits, query, opts.budget)) {
    // re-resolve with the quality floor dropped → cheapest model per task
    pipeline = resolve(plan, query, auth, registry, { honorQualityFloor: false, priority });
    cost = estimate(pipeline, registry);
    degraded = true;
    if (overBudget(cost.credits, query, opts.budget)) {
      throw new ContractError({
        code: "BUDGET_EXCEEDED",
        module: "orchestrator",
        message: `cheapest feasible pipeline costs ${cost.credits} credits, over the limit`,
        retryable: false,
        details: { credits: cost.credits, maxCredits: query.constraints?.maxCredits, budget: opts.budget },
      });
    }
    pipeline = {
      ...pipeline,
      explanation: `${pipeline.explanation ?? ""} [degraded to fit budget]`.trim(),
    };
  }

  // ── emit (module 12 stubbed bus) ──────────────────────────────────────────────
  bus.publish({ type: "pipeline.created", tenantId: query.tenantId, traceId, payload: pipeline });
  bus.publish({
    type: "decision.logged",
    tenantId: query.tenantId,
    traceId,
    payload: {
      actor: "orchestrator",
      decision: `planner=${plannerUsed}, nodes=${pipeline.nodes.length}, degraded=${degraded}`,
      inputs: { query: query.text, constraints: query.constraints },
      output: { models: pipeline.nodes.map((n) => n.modelId), credits: cost.credits },
    },
  });

  return { pipeline, cost, degraded, plannerUsed, traceId };
}

function overBudget(credits: number, query: Query, budget?: BudgetPolicy): boolean {
  const max = query.constraints?.maxCredits;
  if (max !== undefined && credits > max) return true;
  return !checkBudget(credits, budget).allow;
}

async function planWithRepair(
  query: Query,
  opts: OrchestrateOptions,
  maxRepairs: number,
): Promise<{ plan: CapabilityPlan; plannerUsed: string }> {
  let repairFeedback: string | undefined;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    try {
      const raw = await opts.planner.plan({ query, repairFeedback });
      return { plan: validateCapabilityPlan(raw), plannerUsed: opts.planner.name };
    } catch (err) {
      lastError = err;
      if (err instanceof ContractError && err.code === "PLAN_INVALID") {
        const issues = Array.isArray(err.details) ? (err.details as string[]).join("; ") : err.message;
        repairFeedback = issues;
        continue; // re-prompt with feedback
      }
      throw err; // non-recoverable (e.g. transport/config error)
    }
  }

  // fail-safe: deterministic rules fallback
  const fallback = opts.fallbackPlanner ?? new RuleBasedPlanner();
  try {
    const raw = await fallback.plan({ query });
    return { plan: validateCapabilityPlan(raw), plannerUsed: fallback.name };
  } catch {
    throw lastError instanceof Error
      ? lastError
      : new ContractError({
          code: "PLAN_INVALID",
          module: "orchestrator",
          message: "could not produce a valid plan (primary + fallback failed)",
          retryable: false,
        });
  }
}
