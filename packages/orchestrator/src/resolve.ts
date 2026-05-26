import {
  ContractError,
  makeId,
  validatePipelineSpec,
  type AuthContext,
  type Edge,
  type PipelineNode,
  type PipelineSpec,
  type Query,
  type RetryPolicy,
} from "@gentech/contracts";
import type { ModelRegistry } from "@gentech/model-registry";
import type { CapabilityPlan } from "./plan.js";

const DEFAULT_RETRY: RetryPolicy = { maxRetries: 2, backoff: "exponential", deadLetter: true };

/** Stubbed workload size used to turn a per-segment latency into a duration hint. */
const NOMINAL_SEGMENTS = 30;

export interface ResolveOptions {
  /**
   * When true, honor Query.constraints.minQuality as a floor. When false (the
   * degradation path), drop the floor so the globally cheapest model per task wins.
   */
  honorQualityFloor: boolean;
  /** Execution priority for every node's ComputeRequest (from governance / IAM stub). */
  priority: number;
}

/**
 * Stage 2 — deterministic resolution. Maps each capability node to a concrete
 * model from the registry (FR-3), attaches a ComputeRequest hint (FR-4), wires
 * edges from dependsOn, and returns a fully-validated PipelineSpec. No randomness:
 * same plan + registry + options → same spec.
 */
export function resolve(
  plan: CapabilityPlan,
  query: Query,
  auth: AuthContext,
  registry: ModelRegistry,
  opts: ResolveOptions,
): PipelineSpec {
  const minQuality = opts.honorQualityFloor ? query.constraints?.minQuality : undefined;
  const maxLatencyMs = query.constraints?.maxLatencyMs;

  const nodes: PipelineNode[] = plan.nodes.map((cn) => {
    // try most-constrained first, then relax latency, then relax quality
    let candidates = registry.findModels(cn.task, { minQuality, maxLatencyMs });
    if (candidates.length === 0) candidates = registry.findModels(cn.task, { minQuality });
    if (candidates.length === 0) candidates = registry.findModels(cn.task, {});
    const model = candidates[0];
    if (!model) {
      throw new ContractError({
        code: "NO_MODEL_FOR_TASK",
        module: "orchestrator",
        message: `no registry model serves capability "${cn.task}"`,
        retryable: false,
        details: { task: cn.task },
      });
    }
    const estDurationSec = Math.round((NOMINAL_SEGMENTS * model.latencyMsEst) / 100) / 10;
    return {
      nodeId: cn.nodeId,
      task: cn.task,
      modelId: model.modelId,
      params: cn.params,
      compute: {
        gpuClass: model.gpuClass,
        minVramGb: model.minVramGb,
        estDurationSec,
        priority: opts.priority,
      },
      parallelizable: cn.parallelizable,
    };
  });

  const edges: Edge[] = plan.nodes.flatMap((cn) =>
    cn.dependsOn.map((from) => ({ from, to: cn.nodeId })),
  );

  const spec: PipelineSpec = {
    pipelineId: makeId("PipelineId"),
    queryId: query.queryId,
    tenantId: query.tenantId,
    nodes,
    edges,
    explanation: plan.rationale || undefined,
    retryPolicy: DEFAULT_RETRY,
  };

  // hard invariants: schema + acyclic + every modelId resolvable (acceptance criteria)
  return validatePipelineSpec(spec, registry.modelIds);
}
