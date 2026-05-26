import type {
  AuthContext,
  InferenceRequest,
  InferenceResponse,
  MediaSegment,
  PipelineNode,
  PipelineSpec,
} from "@gentech/contracts";
import type { ComputeClient, InferenceClient } from "../dist/index.js";

export const AUTH: AuthContext = {
  tenantId: "ten_test",
  userId: "usr_test",
  roles: ["analyst"],
  scopes: [],
  attrs: {},
};

export function node(nodeId: string, task: string, modelId: string, params: Record<string, unknown> = {}): PipelineNode {
  return {
    nodeId,
    task,
    modelId,
    params,
    compute: { gpuClass: "small", minVramGb: 2, estDurationSec: 1, priority: 5 },
    parallelizable: true,
  };
}

export function spec(nodes: PipelineNode[], edges: { from: string; to: string }[]): PipelineSpec {
  return {
    pipelineId: "pipe_test",
    queryId: "query_test",
    tenantId: "ten_test",
    nodes,
    edges,
    retryPolicy: { maxRetries: 2, backoff: "fixed", deadLetter: true },
  };
}

export function segments(n: number): MediaSegment[] {
  return Array.from({ length: n }, (_, i) => ({
    segmentId: `seg_${i}`,
    sourceId: "src_test",
    tenantId: "ten_test",
    index: i,
    tStart: i * 5,
    tEnd: (i + 1) * 5,
    storageRef: `mock://seg/${i}`,
    codec: "h264",
    final: i === n - 1,
  }));
}

/** A compute client that always grants (CPU-only) — keeps engine tests focused. */
export const grantAllCompute: ComputeClient = {
  async inventory() {
    return {
      total: { none: 999, small: 4 },
      available: { none: 999, small: 4 },
      runningJobs: 0,
      queueDepth: 0,
      updatedAt: "2026-05-26T18:00:00Z",
    };
  },
  async leaseFeasibility(req) {
    return { grantable: true, gpuClass: req.gpuClass ?? "none", endpoint: "mock://worker" };
  },
};

export function okResponse(req: InferenceRequest): InferenceResponse {
  const task = String(req.params.task ?? "");
  const base = { requestId: req.requestId, modelId: req.modelId, latencyMs: 5 };
  if (task === "object_detection") {
    return {
      ...base,
      detections: [{ label: "car", confidence: 0.9, bbox: { x: 0, y: 0, w: 0.1, h: 0.1 }, attrs: { id: `obj_${req.segment.segmentId}` } }],
    };
  }
  return base;
}

/** Minimal inference client driven by a per-request function. */
export function inferenceClient(fn: (req: InferenceRequest) => InferenceResponse): InferenceClient {
  return { async infer(req) { return fn(req); } };
}
