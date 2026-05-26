/**
 * Pure validators reused by every package and by tests. These enforce the
 * PipelineSpec invariants the orchestrator (03) must always satisfy:
 *   - the DAG is acyclic                          (FR-2, acceptance criteria)
 *   - every node.modelId exists in the registry   (acceptance criteria)
 *   - edges reference real nodes, graph is connected from its root(s)
 */
import { ContractError } from "./errors.js";
import { PipelineSpecSchema } from "./schemas.js";
import type { Edge, PipelineSpec } from "./types.js";

const MODULE = "contracts";

interface NodeLike {
  nodeId: string;
}

/** Kahn's algorithm. Throws ContractError{DAG_CYCLIC} if a cycle exists. */
export function assertAcyclic(nodes: readonly NodeLike[], edges: readonly Edge[]): void {
  const ids = new Set(nodes.map((n) => n.nodeId));
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of nodes) {
    indeg.set(n.nodeId, 0);
    adj.set(n.nodeId, []);
  }
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) {
      throw new ContractError({
        code: "DAG_DANGLING_EDGE",
        module: MODULE,
        message: `edge ${e.from}->${e.to} references unknown node`,
        retryable: false,
        details: e,
      });
    }
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const next of adj.get(id)!) {
      const d = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  if (visited !== nodes.length) {
    throw new ContractError({
      code: "DAG_CYCLIC",
      module: MODULE,
      message: "pipeline graph contains a cycle",
      retryable: false,
    });
  }
}

/** Every node's modelId must resolve against the provided registry id set. */
export function assertModelsResolvable(
  spec: Pick<PipelineSpec, "nodes">,
  knownModelIds: ReadonlySet<string>,
): void {
  for (const n of spec.nodes) {
    if (!knownModelIds.has(n.modelId)) {
      throw new ContractError({
        code: "MODEL_NOT_FOUND",
        module: MODULE,
        message: `node ${n.nodeId} references unknown modelId ${n.modelId}`,
        retryable: false,
        details: { nodeId: n.nodeId, modelId: n.modelId },
      });
    }
  }
}

/**
 * Full structural validation: schema + acyclicity + connectivity.
 * `knownModelIds` is optional; when supplied, model resolvability is also checked.
 */
export function validatePipelineSpec(
  spec: unknown,
  knownModelIds?: ReadonlySet<string>,
): PipelineSpec {
  const parsed = PipelineSpecSchema.safeParse(spec);
  if (!parsed.success) {
    throw new ContractError({
      code: "PIPELINE_SCHEMA_INVALID",
      module: MODULE,
      message: "PipelineSpec failed schema validation",
      retryable: false,
      details: parsed.error.flatten(),
    });
  }
  const value = parsed.data;
  assertAcyclic(value.nodes, value.edges);

  // every non-root node must be reachable; detect orphan nodes with no path from a root
  const hasIncoming = new Set(value.edges.map((e) => e.to));
  const roots = value.nodes.filter((n) => !hasIncoming.has(n.nodeId));
  if (value.nodes.length > 1 && roots.length === 0) {
    throw new ContractError({
      code: "DAG_NO_ROOT",
      module: MODULE,
      message: "graph has no root node (every node has an incoming edge)",
      retryable: false,
    });
  }

  if (knownModelIds) assertModelsResolvable(value, knownModelIds);
  return value;
}
