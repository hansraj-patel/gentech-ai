import { z } from "zod";
import { ContractError, type Query } from "@gentech/contracts";
import { CAPABILITIES, isKnownTask } from "./ontology.js";

/**
 * The LLM's output (stage 1): a capability-level DAG — tasks + params + topology,
 * but NO model picks (those are the deterministic resolver's job, stage 2).
 */
export const CapabilityNodeSchema = z.object({
  nodeId: z.string().min(1),
  task: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  parallelizable: z.boolean().default(false),
  dependsOn: z.array(z.string()).default([]),
});
export const CapabilityPlanSchema = z.object({
  nodes: z.array(CapabilityNodeSchema).min(1),
  rationale: z.string().default(""),
});
export type CapabilityNode = z.infer<typeof CapabilityNodeSchema>;
export type CapabilityPlan = z.infer<typeof CapabilityPlanSchema>;

export interface PlanInput {
  query: Query;
  /** Validation errors from a previous attempt, fed back for the repair loop. */
  repairFeedback?: string;
}

/** A planner turns NL intent into a capability-level DAG. */
export interface Planner {
  readonly name: string;
  plan(input: PlanInput): Promise<CapabilityPlan>;
}

/**
 * Validate a raw plan against the schema + ontology + per-capability param schemas
 * + structural sanity (unique ids, deps reference real nodes). Returns a normalized
 * plan or throws ContractError{PLAN_INVALID} with human-readable issues (used as
 * repair feedback).
 */
export function validateCapabilityPlan(raw: unknown): CapabilityPlan {
  const parsed = CapabilityPlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ContractError({
      code: "PLAN_INVALID",
      module: "orchestrator",
      message: "capability plan failed schema validation",
      retryable: true,
      details: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    });
  }
  const plan = parsed.data;
  const issues: string[] = [];
  const ids = new Set<string>();

  for (const node of plan.nodes) {
    if (ids.has(node.nodeId)) issues.push(`duplicate nodeId "${node.nodeId}"`);
    ids.add(node.nodeId);
    if (!isKnownTask(node.task)) {
      issues.push(`unknown task "${node.task}" (not in ontology) at node "${node.nodeId}"`);
      continue;
    }
    const paramCheck = CAPABILITIES[node.task]!.paramsSchema.safeParse(node.params);
    if (!paramCheck.success) {
      issues.push(`invalid params for "${node.task}" at "${node.nodeId}"`);
    }
  }
  for (const node of plan.nodes) {
    for (const dep of node.dependsOn) {
      if (!ids.has(dep)) issues.push(`node "${node.nodeId}" depends on unknown node "${dep}"`);
      if (dep === node.nodeId) issues.push(`node "${node.nodeId}" depends on itself`);
    }
  }

  if (issues.length) {
    throw new ContractError({
      code: "PLAN_INVALID",
      module: "orchestrator",
      message: "capability plan failed ontology/structure validation",
      retryable: true,
      details: issues,
    });
  }
  return plan;
}
