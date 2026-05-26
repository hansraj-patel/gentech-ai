/**
 * Compute usage accounting + event emission (module 05, FR — "emits
 * compute.lease.granted + usage.recorded"). The scheduler reports usage; module
 * 11 prices it. gpu-seconds are derived from the lease's wall lifetime (grant →
 * release) so a released lease meters exactly what it held.
 *
 * Emission is decoupled: callers inject an `emit(topic, payload)` callback (the
 * control-plane bus wires it in). We import only `TOPICS` from contracts — never
 * the control-plane — to keep this module a leaf.
 */
import type { Event, UsageEvent, WorkerLease } from "@gentech/contracts";
import { TOPICS } from "@gentech/contracts";

/** Injected sink: the host (module 12) passes its bus `emit` here. */
export type EmitFn = (topic: string, payload: Event) => void;

let usageCounter = 0;
const newUsageId = (): string => `usage_${(++usageCounter).toString(36).padStart(4, "0")}`;

let eventCounter = 0;
const newEventId = (): string => `evt_${(++eventCounter).toString(36).padStart(4, "0")}`;

/** Reset id counters — deterministic ids for tests. */
export function _resetUsageIds(): void {
  usageCounter = 0;
  eventCounter = 0;
}

/** Wrap a payload in the §7 event envelope. */
function envelope<T>(args: {
  type: string;
  tenantId: string;
  jobId?: string;
  traceId: string;
  ts: string;
  payload: T;
}): Event<T> {
  return {
    eventId: newEventId(),
    type: args.type,
    tenantId: args.tenantId,
    ...(args.jobId ? { jobId: args.jobId } : {}),
    traceId: args.traceId,
    ts: args.ts,
    payload: args.payload,
  };
}

/** Emit `compute.lease.granted` for a freshly granted lease. */
export function emitLeaseGranted(
  emit: EmitFn,
  lease: WorkerLease,
  tenantId: string,
  traceId: string,
): void {
  emit(
    TOPICS.computeLeaseGranted,
    envelope({
      type: TOPICS.computeLeaseGranted,
      tenantId,
      jobId: lease.jobId,
      traceId,
      ts: lease.grantedAt,
      payload: lease,
    }) as Event,
  );
}

/**
 * Build the `UsageEvent` for a lease over its held lifetime and emit
 * `usage.recorded`. CPU-only leases meter as `gpuClass:"none"` with gpu-seconds
 * still reported (the unit of compute time the worker held).
 */
export function recordUsage(
  emit: EmitFn,
  args: {
    lease: WorkerLease;
    tenantId: string;
    traceId: string;
    releasedAtIso: string;
  },
): UsageEvent {
  const gpuSeconds = Math.max(
    0,
    (Date.parse(args.releasedAtIso) - Date.parse(args.lease.grantedAt)) / 1000,
  );
  const usage: UsageEvent = {
    usageId: newUsageId(),
    tenantId: args.tenantId,
    jobId: args.lease.jobId,
    gpuSeconds: Number(gpuSeconds.toFixed(4)),
    gpuClass: args.lease.gpuClass,
    ts: args.releasedAtIso,
  };
  emit(
    TOPICS.usageRecorded,
    envelope({
      type: TOPICS.usageRecorded,
      tenantId: args.tenantId,
      jobId: args.lease.jobId,
      traceId: args.traceId,
      ts: args.releasedAtIso,
      payload: usage,
    }) as Event,
  );
  return usage;
}
