/**
 * Reliability primitives (module 04, FR-5): bounded retries with backoff, a
 * per-node circuit breaker, and an idempotent checkpoint store. Together they give
 * the engine's two hard guarantees: a single node failure never loses completed
 * upstream results, and retries never double-count (exactly-once aggregation).
 */
import type { InferenceResponse, RetryPolicy } from "@gentech/contracts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RetryOptions {
  /** Base backoff in ms (kept tiny so tests are fast). */
  baseMs?: number;
  onRetry?: (attempt: number, err: unknown) => void;
}

/** Run `fn`, retrying up to policy.maxRetries on throw. Rethrows the last error. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  opts: RetryOptions = {},
): Promise<T> {
  const base = opts.baseMs ?? 2;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= policy.maxRetries) throw err;
      opts.onRetry?.(attempt, err);
      const delay = policy.backoff === "exponential" ? base * 2 ** attempt : base;
      await sleep(delay);
      attempt += 1;
    }
  }
}

/**
 * Idempotent result store keyed by (nodeId, segmentId). Retries overwrite the same
 * key, so aggregation that reads the store can never count a unit twice (NFR:
 * exactly-once). It is also the partial-recovery checkpoint: completed units
 * survive a later node's failure.
 */
export class CheckpointStore {
  private readonly store = new Map<string, InferenceResponse>();

  private key(nodeId: string, segmentId: string): string {
    return `${nodeId}::${segmentId}`;
  }

  has(nodeId: string, segmentId: string): boolean {
    return this.store.has(this.key(nodeId, segmentId));
  }

  put(nodeId: string, segmentId: string, res: InferenceResponse): void {
    this.store.set(this.key(nodeId, segmentId), res);
  }

  all(): InferenceResponse[] {
    return [...this.store.values()];
  }

  /** Responses produced by a specific set of node ids (for scoped aggregation). */
  forNodes(nodeIds: ReadonlySet<string>): InferenceResponse[] {
    const out: InferenceResponse[] = [];
    for (const [k, v] of this.store) {
      if (nodeIds.has(k.split("::")[0]!)) out.push(v);
    }
    return out;
  }

  get size(): number {
    return this.store.size;
  }
}

/**
 * Trip after a node accrues `threshold` failures across segments; once open the
 * engine skips the node's remaining segments instead of hammering a failing model.
 */
export class CircuitBreaker {
  private readonly failures = new Map<string, number>();
  private readonly open = new Set<string>();

  constructor(private readonly threshold = 1) {}

  recordFailure(nodeId: string): void {
    const n = (this.failures.get(nodeId) ?? 0) + 1;
    this.failures.set(nodeId, n);
    if (n >= this.threshold) this.open.add(nodeId);
  }

  isOpen(nodeId: string): boolean {
    return this.open.has(nodeId);
  }
}
