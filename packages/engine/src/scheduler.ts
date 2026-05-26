/**
 * Topological leveling (module 04, FR-1): turn the PipelineSpec DAG into ordered
 * "levels" of nodes. Nodes in the same level have no dependency between them and
 * run concurrently; later levels wait on earlier ones. Reuses the contract's
 * acyclicity check (Kahn) so a malformed spec fails loud before any work starts.
 */
import { assertAcyclic, type PipelineNode, type PipelineSpec } from "@gentech/contracts";

export function topoLevels(spec: PipelineSpec): PipelineNode[][] {
  assertAcyclic(spec.nodes, spec.edges); // throws DAG_CYCLIC / DAG_DANGLING_EDGE

  const byId = new Map(spec.nodes.map((n) => [n.nodeId, n]));
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>();
  for (const n of spec.nodes) {
    indeg.set(n.nodeId, 0);
    adj.set(n.nodeId, []);
  }
  for (const e of spec.edges) {
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }

  const levels: PipelineNode[][] = [];
  let frontier = spec.nodes.filter((n) => (indeg.get(n.nodeId) ?? 0) === 0);
  const seen = new Set<string>();

  while (frontier.length) {
    levels.push(frontier);
    const next: PipelineNode[] = [];
    for (const n of frontier) {
      seen.add(n.nodeId);
      for (const m of adj.get(n.nodeId)!) {
        const d = (indeg.get(m) ?? 0) - 1;
        indeg.set(m, d);
        if (d === 0 && !seen.has(m)) next.push(byId.get(m)!);
      }
    }
    frontier = next;
  }
  return levels;
}
