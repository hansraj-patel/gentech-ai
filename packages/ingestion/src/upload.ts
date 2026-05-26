/**
 * Module 01 — resumable chunked upload (FR-2, acceptance: resume from last ack).
 *
 * An `UploadSession` tracks which chunk indices have arrived. `putChunk` is
 * idempotent (re-sending an already-acked chunk is a no-op) and out-of-order
 * tolerant (chunk 5 may arrive before chunk 2). For a finite upload the caller
 * declares `totalChunks` (via `finalize`) so completion can be detected: an
 * upload is complete once every index in [0, totalChunks) has been received.
 *
 * Bytes are opaque here — no pixel decode (v1: "intelligence real, pixels faked").
 * We track lengths/offsets for bookkeeping but the segmenter only ever sees that
 * bytes exist, never their contents.
 */
import { ContractError } from "@gentech/contracts";

function badRequest(message: string): never {
  throw new ContractError({ code: "INGEST_BAD_UPLOAD", module: "ingestion", message, retryable: false });
}

export interface ChunkReceipt {
  index: number;
  bytes: number; // length of this chunk
  duplicate: boolean; // true if this index was already present (idempotent no-op)
}

/**
 * Bookkeeping for a single resumable upload. `receivedChunks` is the set of
 * acked indices; `totalBytes` accumulates received byte counts. Reassembly order
 * is recovered by sorting `receivedChunks` — out-of-order arrival is fine.
 */
export class UploadSession {
  readonly sessionId: string;
  readonly sourceId: string;
  readonly tenantId: string;
  readonly receivedChunks = new Set<number>();
  totalBytes = 0;
  /** Declared chunk count for a finite upload; undefined until `finalize`. */
  totalChunks?: number;

  private readonly lengths = new Map<number, number>();

  constructor(args: { sessionId: string; sourceId: string; tenantId: string }) {
    this.sessionId = args.sessionId;
    this.sourceId = args.sourceId;
    this.tenantId = args.tenantId;
  }

  /**
   * Accept a chunk. Idempotent: a duplicate index is acked again without changing
   * `totalBytes`. Out-of-order tolerant: any non-negative index is accepted.
   */
  put(index: number, bytes: Uint8Array): ChunkReceipt {
    if (!Number.isInteger(index) || index < 0) badRequest(`invalid chunk index ${index}`);
    if (this.totalChunks !== undefined && index >= this.totalChunks) {
      badRequest(`chunk index ${index} beyond declared total ${this.totalChunks}`);
    }
    if (this.receivedChunks.has(index)) {
      // Idempotent: re-uploading an acked chunk does not double-count bytes.
      return { index, bytes: this.lengths.get(index) ?? 0, duplicate: true };
    }
    this.receivedChunks.add(index);
    this.lengths.set(index, bytes.length);
    this.totalBytes += bytes.length;
    return { index, bytes: bytes.length, duplicate: false };
  }

  /** Declare the finite chunk count so completion can be detected (FR-5 stream end). */
  finalize(totalChunks: number): void {
    if (!Number.isInteger(totalChunks) || totalChunks < 0) {
      badRequest(`invalid totalChunks ${totalChunks}`);
    }
    for (const i of this.receivedChunks) {
      if (i >= totalChunks) badRequest(`already received chunk ${i} ≥ declared total ${totalChunks}`);
    }
    this.totalChunks = totalChunks;
  }

  /** The next contiguous index not yet received (resume point after a kill). */
  nextExpectedIndex(): number {
    let i = 0;
    while (this.receivedChunks.has(i)) i++;
    return i;
  }

  /** Contiguous prefix length [0..k) that has arrived — what the segmenter can consume. */
  contiguousCount(): number {
    return this.nextExpectedIndex();
  }

  /** True once every declared chunk has been received (completion detection). */
  isComplete(): boolean {
    return this.totalChunks !== undefined && this.receivedChunks.size === this.totalChunks;
  }
}

let seq = 0;
function freshSessionId(): string {
  return `upl_${Date.now().toString(36)}${(++seq).toString(36).padStart(3, "0")}`;
}

/** Tracks all in-flight upload sessions. */
export class UploadManager {
  private readonly bySession = new Map<string, UploadSession>();

  /** Begin an upload session for a source (FR-2). */
  open(args: { sourceId: string; tenantId: string; sessionId?: string }): UploadSession {
    const session = new UploadSession({
      sessionId: args.sessionId ?? freshSessionId(),
      sourceId: args.sourceId,
      tenantId: args.tenantId,
    });
    this.bySession.set(session.sessionId, session);
    return session;
  }

  get(sessionId: string): UploadSession {
    const s = this.bySession.get(sessionId);
    if (!s) badRequest(`unknown upload session ${sessionId}`);
    return s;
  }

  /** Idempotent + out-of-order tolerant chunk write. */
  putChunk(sessionId: string, index: number, bytes: Uint8Array): ChunkReceipt {
    return this.get(sessionId).put(index, bytes);
  }
}
