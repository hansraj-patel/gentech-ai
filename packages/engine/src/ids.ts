/**
 * Local id minting for the runtime-plane ids the engine owns (job/result/usage/
 * request/event/trace). Kept here rather than in @gentech/contracts to keep this
 * module's footprint on the shared (contested) package to a single export line.
 */
let counter = 0;
function mint(prefix: string, seed?: string): string {
  return `${prefix}${seed ?? (++counter).toString(36).padStart(4, "0")}`;
}

export const newJobId = (seed?: string) => mint("job_", seed);
export const newResultId = (seed?: string) => mint("result_", seed);
export const newUsageId = (seed?: string) => mint("usage_", seed);
export const newRequestId = (seed?: string) => mint("req_", seed);
export const newEventId = (seed?: string) => mint("evt_", seed);
export const newLeaseId = (seed?: string) => mint("lease_", seed);
export const newTraceId = (seed?: string) => mint("trace_", seed);

/** Reset the counter (tests that assert on ids want determinism). */
export const _resetIds = () => {
  counter = 0;
};
