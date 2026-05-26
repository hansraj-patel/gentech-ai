/**
 * Usage accounting (module 04, FR-7): turn executed work into UsageEvents that
 * module 11 meters for billing. v1 derives gpu-seconds from the (mock) inference
 * latency per node/class — the same signal a real worker would report.
 */
import type { UsageEvent } from "@gentech/contracts";
import { newUsageId } from "./ids.js";

export function buildUsage(args: {
  tenantId: string;
  jobId: string;
  gpuClass: string;
  gpuSeconds: number;
  now: () => string;
}): UsageEvent {
  return {
    usageId: newUsageId(),
    tenantId: args.tenantId,
    jobId: args.jobId,
    gpuSeconds: Number(args.gpuSeconds.toFixed(4)),
    gpuClass: args.gpuClass,
    ts: args.now(),
  };
}
