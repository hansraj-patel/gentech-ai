import type { CostEstimate, GpuClass, PipelineSpec } from "@gentech/contracts";
import type { ModelRegistry } from "@gentech/model-registry";

/**
 * Module 11 — pre-execution cost estimation. The *math* is real (FR-2); only the
 * GPU-seconds inputs are stubbed (a nominal segment count) since no real GPUs run
 * in v1 — module 13 supplies real inventory/timings later without changing this.
 */

/** Credits charged per GPU-second by class (the v1 rate card). */
const GPU_RATE_PER_SEC: Record<GpuClass, number> = {
  none: 1, // CPU-only work is cheap but not free
  small: 4,
  medium: 10,
  large: 25,
};

const GPU_ORDER: Record<GpuClass, number> = { none: 0, small: 1, medium: 2, large: 3 };

/** Stubbed workload size: how many segments a node nominally processes. */
const NOMINAL_SEGMENTS = 30;

function nodeDurationSec(estDurationSec: number | undefined, latencyMsEst: number): number {
  if (estDurationSec !== undefined && estDurationSec > 0) return estDurationSec;
  return (NOMINAL_SEGMENTS * latencyMsEst) / 1000;
}

/** Longest path (critical path) of durations through the DAG — the wall-clock estimate. */
function criticalPathSec(
  spec: PipelineSpec,
  durationByNode: Map<string, number>,
): number {
  const adj = new Map<string, string[]>();
  const indeg = new Map<string, number>();
  for (const n of spec.nodes) {
    adj.set(n.nodeId, []);
    indeg.set(n.nodeId, 0);
  }
  for (const e of spec.edges) {
    adj.get(e.from)!.push(e.to);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  // longest-path DP in topological order
  const best = new Map<string, number>();
  const queue = [...indeg].filter(([, d]) => d === 0).map(([id]) => id);
  for (const id of queue) best.set(id, durationByNode.get(id) ?? 0);
  while (queue.length) {
    const id = queue.shift()!;
    const here = best.get(id) ?? 0;
    for (const next of adj.get(id)!) {
      const candidate = here + (durationByNode.get(next) ?? 0);
      if (candidate > (best.get(next) ?? -1)) best.set(next, candidate);
      const d = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  return Math.max(0, ...best.values());
}

export function estimate(spec: PipelineSpec, registry: ModelRegistry): CostEstimate {
  const breakdown: { item: string; credits: number }[] = [];
  const durationByNode = new Map<string, number>();
  let dominantGpu: GpuClass = "none";

  for (const node of spec.nodes) {
    const model = registry.get(node.modelId);
    const latency = model?.latencyMsEst ?? 20;
    const costWeight = model?.costWeight ?? 1;
    const gpuClass = (node.compute.gpuClass ?? model?.gpuClass ?? "none") as GpuClass;

    const durSec = nodeDurationSec(node.compute.estDurationSec, latency);
    durationByNode.set(node.nodeId, durSec);
    if (GPU_ORDER[gpuClass] > GPU_ORDER[dominantGpu]) dominantGpu = gpuClass;

    const credits = Math.ceil(costWeight * durSec * GPU_RATE_PER_SEC[gpuClass]);
    breakdown.push({ item: `${node.task} (${node.modelId})`, credits });
  }

  const credits = breakdown.reduce((sum, b) => sum + b.credits, 0);
  const runtimeSecEst = Math.round(criticalPathSec(spec, durationByNode) * 10) / 10;

  return {
    pipelineId: spec.pipelineId,
    credits,
    breakdown,
    runtimeSecEst,
    gpuClassEst: dominantGpu,
    // GPU-seconds are stubbed in v1, so we never claim "high" confidence.
    confidence: "medium",
  };
}
