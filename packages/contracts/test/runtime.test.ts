import { describe, it, expect } from "vitest";
import {
  InferenceRequestSchema,
  InferenceResponseSchema,
  ResultEventSchema,
  MediaSegmentSchema,
  JobStatusSchema,
  WorkerLeaseSchema,
  GpuInventorySchema,
  UsageEventSchema,
  makeEventSchema,
} from "../dist/index.js";
import { z } from "zod";

const NOW = "2026-05-26T18:00:00Z";

describe("runtime schemas — accept valid fixtures", () => {
  it("InferenceRequest / InferenceResponse", () => {
    expect(
      InferenceRequestSchema.safeParse({
        requestId: "req_1",
        jobId: "job_1",
        nodeId: "node_detect",
        modelId: "yolo-n",
        segment: { segmentId: "seg_0", storageRef: "blob://x" },
        params: { classes: ["car"] },
      }).success,
    ).toBe(true);

    expect(
      InferenceResponseSchema.safeParse({
        requestId: "req_1",
        modelId: "yolo-n",
        latencyMs: 12,
        detections: [{ label: "car", confidence: 0.91, bbox: { x: 0.1, y: 0.2, w: 0.1, h: 0.1 }, attrs: { color: "white" } }],
      }).success,
    ).toBe(true);
  });

  it("ResultEvent / JobStatus / MediaSegment", () => {
    expect(
      ResultEventSchema.safeParse({
        resultId: "result_1",
        jobId: "job_1",
        tenantId: "ten_1",
        kind: "count",
        partial: true,
        payload: { count: 7 },
        ts: NOW,
      }).success,
    ).toBe(true);

    expect(
      JobStatusSchema.safeParse({
        jobId: "job_1",
        pipelineId: "pipe_1",
        tenantId: "ten_1",
        state: "running",
        nodeStates: { node_detect: "running" },
        progress: 0.5,
        costSoFar: 0,
      }).success,
    ).toBe(true);

    expect(
      MediaSegmentSchema.safeParse({
        segmentId: "seg_0",
        sourceId: "src_1",
        tenantId: "ten_1",
        index: 0,
        tStart: 0,
        tEnd: 5,
        storageRef: "blob://x",
        codec: "h264",
        final: false,
      }).success,
    ).toBe(true);
  });

  it("WorkerLease / GpuInventory / UsageEvent", () => {
    expect(
      WorkerLeaseSchema.safeParse({
        leaseId: "lease_1",
        jobId: "job_1",
        gpuClass: "small",
        vramGb: 4,
        cpuOnly: false,
        grantedAt: NOW,
        expiresAt: NOW,
        endpoint: "http://mock/infer",
      }).success,
    ).toBe(true);

    expect(
      GpuInventorySchema.safeParse({
        total: { small: 4, medium: 2 },
        available: { small: 1, medium: 0 },
        runningJobs: 3,
        queueDepth: 2,
        updatedAt: NOW,
      }).success,
    ).toBe(true);

    expect(
      UsageEventSchema.safeParse({
        usageId: "usage_1",
        tenantId: "ten_1",
        jobId: "job_1",
        gpuSeconds: 1.5,
        gpuClass: "small",
        ts: NOW,
      }).success,
    ).toBe(true);
  });

  it("makeEventSchema wraps a typed payload", () => {
    const schema = makeEventSchema(z.object({ count: z.number() }));
    expect(
      schema.safeParse({
        eventId: "evt_1",
        type: "result.event",
        tenantId: "ten_1",
        ts: NOW,
        traceId: "trace_1",
        payload: { count: 7 },
      }).success,
    ).toBe(true);
  });
});

describe("runtime schemas — reject bad fixtures", () => {
  it("rejects out-of-range confidence and nsfwScore", () => {
    expect(
      InferenceResponseSchema.safeParse({
        requestId: "req_1",
        modelId: "yolo-n",
        latencyMs: 12,
        detections: [{ label: "car", confidence: 1.5, bbox: { x: 0, y: 0, w: 1, h: 1 } }],
      }).success,
    ).toBe(false);

    expect(
      InferenceResponseSchema.safeParse({ requestId: "r", modelId: "m", latencyMs: 1, nsfwScore: 2 }).success,
    ).toBe(false);
  });

  it("rejects invalid job state and progress", () => {
    expect(
      JobStatusSchema.safeParse({
        jobId: "job_1",
        pipelineId: "pipe_1",
        tenantId: "ten_1",
        state: "exploded",
        nodeStates: {},
        progress: 0,
        costSoFar: 0,
      }).success,
    ).toBe(false);

    expect(
      JobStatusSchema.safeParse({
        jobId: "job_1",
        pipelineId: "pipe_1",
        tenantId: "ten_1",
        state: "running",
        nodeStates: {},
        progress: 2,
        costSoFar: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown ResultEvent kind", () => {
    expect(
      ResultEventSchema.safeParse({
        resultId: "result_1",
        jobId: "job_1",
        tenantId: "ten_1",
        kind: "hologram",
        partial: false,
        payload: {},
        ts: NOW,
      }).success,
    ).toBe(false);
  });
});
