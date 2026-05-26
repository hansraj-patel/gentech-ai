/**
 * Priority queue + lease bookkeeping (module 05, FR-4/FR-6).
 *
 * Ordering: higher priority first, FIFO within a priority band (insertion order
 * breaks ties). Aging (NFR "no starvation") is applied as an effective-priority
 * bump the longer a request waits, so low-priority work eventually overtakes the
 * band it sits below. Active leases are tracked so capacity can be reclaimed on
 * `release()` or when `reap(now)` sweeps expired leases (teardown bookkeeping).
 */
import type { ComputeRequest, WorkerLease } from "@gentech/contracts";

/** A queued lease request awaiting a grant. */
export interface QueuedRequest {
  jobId: string;
  nodeId?: string;
  tenantId: string;
  req: ComputeRequest;
  priority: number; // 0..9, resolved from iam.priorityFor
  enqueuedAtMs: number; // wall/sim ms at enqueue, for aging + FIFO tiebreak
  seq: number; // monotonic insertion counter (stable FIFO within a band)
}

/** Aging: every `AGING_INTERVAL_MS` waited lifts effective priority by 1 (capped 9). */
const AGING_INTERVAL_MS = 30_000;

function effectivePriority(r: QueuedRequest, nowMs: number): number {
  const waitedMs = Math.max(0, nowMs - r.enqueuedAtMs);
  const bump = Math.floor(waitedMs / AGING_INTERVAL_MS);
  return Math.min(9, r.priority + bump);
}

/**
 * In-memory priority queue. Not a binary heap — request volumes here are small and
 * aging changes effective ordering over time, so we sort on dequeue for clarity.
 */
export class PriorityQueue {
  private items: QueuedRequest[] = [];
  private seqCounter = 0;

  get size(): number {
    return this.items.length;
  }

  enqueue(entry: Omit<QueuedRequest, "seq">): QueuedRequest {
    const queued: QueuedRequest = { ...entry, seq: this.seqCounter++ };
    this.items.push(queued);
    return queued;
  }

  /** Highest effective-priority request, FIFO within a band. Non-destructive. */
  peek(nowMs: number): QueuedRequest | undefined {
    if (this.items.length === 0) return undefined;
    return [...this.items].sort((a, b) => {
      const pa = effectivePriority(a, nowMs);
      const pb = effectivePriority(b, nowMs);
      if (pa !== pb) return pb - pa; // higher priority first
      return a.seq - b.seq; // FIFO tiebreak
    })[0];
  }

  /** Remove and return the next-to-run request (see `peek`). */
  dequeue(nowMs: number): QueuedRequest | undefined {
    const next = this.peek(nowMs);
    if (!next) return undefined;
    this.items = this.items.filter((i) => i.seq !== next.seq);
    return next;
  }

  /** Ordered snapshot (highest effective priority first) — for inspection/tests. */
  snapshot(nowMs: number): QueuedRequest[] {
    return [...this.items].sort((a, b) => {
      const pa = effectivePriority(a, nowMs);
      const pb = effectivePriority(b, nowMs);
      if (pa !== pb) return pb - pa;
      return a.seq - b.seq;
    });
  }
}

/** Active-lease registry: reclaim capacity on release or expiry sweep. */
export class LeaseRegistry {
  private active = new Map<string, WorkerLease>();

  get activeCount(): number {
    return this.active.size;
  }

  add(lease: WorkerLease): void {
    this.active.set(lease.leaseId, lease);
  }

  get(leaseId: string): WorkerLease | undefined {
    return this.active.get(leaseId);
  }

  /** Count of active (non-CPU) leases per GPU class — drives capacity accounting. */
  inUseByClass(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const l of this.active.values()) {
      if (l.cpuOnly) continue;
      counts[l.gpuClass] = (counts[l.gpuClass] ?? 0) + 1;
    }
    return counts;
  }

  /** Release one lease (triggers teardown bookkeeping in the scheduler). */
  release(leaseId: string): WorkerLease | undefined {
    const lease = this.active.get(leaseId);
    if (lease) this.active.delete(leaseId);
    return lease;
  }

  /** Sweep leases whose `expiresAt` is at/under `nowIso`; returns the reclaimed ones. */
  reap(nowIso: string): WorkerLease[] {
    const reaped: WorkerLease[] = [];
    for (const lease of [...this.active.values()]) {
      if (Date.parse(lease.expiresAt) <= Date.parse(nowIso)) {
        this.active.delete(lease.leaseId);
        reaped.push(lease);
      }
    }
    return reaped;
  }

  all(): WorkerLease[] {
    return [...this.active.values()];
  }
}
