/**
 * Module 01 — progressive segmentation (FR-4, FR-5).
 *
 * Turns a growing run of upload chunks into a stream of `MediaSegment`s. Each
 * source has its own segmenter holding a MONOTONIC `index` counter (FR-5).
 * Segments are emitted PROGRESSIVELY — as soon as enough chunks have arrived to
 * fill one temporal window, before the upload completes (FR-4). The last segment
 * of a finite upload carries `final: true` (FR-5).
 *
 * v1 "pixels faked": bytes are opaque. We never decode frames; a segment maps to
 * a fixed window of chunks and carries an OPAQUE `storageRef`
 * (`ingest://<sourceId>/<index>`) pointing at where those bytes live — NOT the
 * bytes themselves. Output is deterministic given a fixed `windowChunks`.
 */
import {
  MediaSegmentSchema,
  type MediaSegment,
  type CompressionPlan,
} from "@gentech/contracts";

export interface SegmenterOptions {
  /** Chunks per temporal window (segment). Fixed → deterministic output. */
  windowChunks?: number;
  /** Seconds of media each chunk represents (for tStart/tEnd bookkeeping). */
  secondsPerChunk?: number;
  /** Codec label stamped on every segment (bytes are not inspected). */
  codec?: string;
}

const DEFAULT_WINDOW_CHUNKS = 4;
const DEFAULT_SECONDS_PER_CHUNK = 1;

/** Tenant-scoped, unguessable-ish opaque pointer to stored bytes (NFR). */
export function makeStorageRef(tenantId: string, sourceId: string, index: number): string {
  return `ingest://${tenantId}/${sourceId}/${index}`;
}

/**
 * Per-source progressive segmenter. Feed it the contiguous chunk count seen so
 * far (and whether the upload is finished); it returns any newly-completable
 * segments with monotonically increasing `index`.
 */
export class Segmenter {
  private readonly windowChunks: number;
  private readonly secondsPerChunk: number;
  private readonly codec: string;

  /** Next segment index to emit — monotonic, never reused (FR-5). */
  private nextIndex = 0;
  /** How many chunks have already been consumed into emitted segments. */
  private consumedChunks = 0;
  private finalEmitted = false;

  constructor(
    private readonly tenantId: string,
    private readonly sourceId: string,
    opts: SegmenterOptions = {},
    compression?: CompressionPlan,
  ) {
    this.windowChunks = opts.windowChunks ?? DEFAULT_WINDOW_CHUNKS;
    // A negotiated CompressionPlan can carry segmentation hints; default otherwise.
    this.secondsPerChunk = opts.secondsPerChunk ?? DEFAULT_SECONDS_PER_CHUNK;
    this.codec = opts.codec ?? (compression ? "h264" : "h264");
  }

  /**
   * Emit every segment that the bytes seen so far can fill.
   *
   * @param contiguousChunks number of in-order chunks available [0..n)
   * @param uploadComplete   true once the finite upload has fully arrived
   *
   * While the upload is in progress, only FULL windows are emitted (progressive).
   * On completion, a trailing partial window is flushed and the last segment is
   * marked `final: true`. Exactly one `final` segment is ever produced per source.
   */
  advance(contiguousChunks: number, uploadComplete: boolean): MediaSegment[] {
    if (this.finalEmitted) return [];
    const out: MediaSegment[] = [];

    // Emit all full windows that are now backed by contiguous bytes.
    while (contiguousChunks - this.consumedChunks >= this.windowChunks) {
      const isLast = uploadComplete && contiguousChunks - (this.consumedChunks + this.windowChunks) === 0;
      out.push(this.cut(this.windowChunks, isLast));
      if (isLast) return out;
    }

    // On completion, flush a trailing partial window (and mark it final).
    if (uploadComplete && !this.finalEmitted) {
      const remaining = contiguousChunks - this.consumedChunks;
      out.push(this.cut(remaining, true)); // remaining may be 0 → a final marker segment
    }

    return out;
  }

  private cut(chunkCount: number, isFinal: boolean): MediaSegment {
    const index = this.nextIndex++;
    const tStart = this.consumedChunks * this.secondsPerChunk;
    this.consumedChunks += chunkCount;
    const tEnd = this.consumedChunks * this.secondsPerChunk;
    if (isFinal) this.finalEmitted = true;
    return MediaSegmentSchema.parse({
      segmentId: `seg_${this.sourceId}_${index}`,
      sourceId: this.sourceId,
      tenantId: this.tenantId,
      index,
      tStart,
      tEnd,
      storageRef: makeStorageRef(this.tenantId, this.sourceId, index),
      codec: this.codec,
      final: isFinal,
    });
  }
}
