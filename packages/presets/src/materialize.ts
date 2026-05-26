/**
 * Preset → PipelineSpec materialization (module 07, FR-1/FR-2). A preset's
 * natural-language objective template is filled with params, turned into a
 * `Query` via the orchestrator's `buildQuery`, then run through `orchestrate`
 * (default planner: the deterministic `RuleBasedPlanner`) to produce the very
 * same `PipelineSpec` an ad-hoc NL query would — so execution (module 04) is
 * reused unchanged. The result is validated with `validatePipelineSpec`.
 */
import {
  validatePipelineSpec,
  type PipelineSpec,
} from "@gentech/contracts";
import {
  buildQuery,
  orchestrate,
  RuleBasedPlanner,
  type Planner,
} from "@gentech/orchestrator";
import { fillTemplate, type PresetDefinition } from "./catalog.js";

export interface MaterializeContext {
  /** Planner to drive the orchestrator; defaults to a deterministic RuleBasedPlanner. */
  planner?: Planner;
  /** Source ids the monitor binds to. */
  sources: string[];
  tenantId: string;
}

/**
 * Materialize a preset into a validated `PipelineSpec` for the given params,
 * sources, and tenant. Caller params override the preset's `defaultParams`.
 */
export async function materialize(
  preset: PresetDefinition,
  params: Record<string, unknown>,
  ctx: MaterializeContext,
): Promise<PipelineSpec> {
  const merged = { ...preset.defaultParams, ...params };
  const text = fillTemplate(preset.objective, merged);
  const query = buildQuery({ text, tenantId: ctx.tenantId, sources: ctx.sources });

  const { pipeline } = await orchestrate(query, {
    planner: ctx.planner ?? new RuleBasedPlanner(),
  });

  // structural validation (acyclic DAG, dangling-edge & root checks). Models are
  // already resolved against the registry inside `orchestrate`, so the spec is
  // model-valid by construction; this re-asserts the contract invariants.
  return validatePipelineSpec(pipeline);
}
