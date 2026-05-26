/**
 * Module 01 — ingestion gateway (ties registration + upload + segmentation).
 *
 * `IngestionGateway` is the module's public surface. It is DECOUPLED from the
 * engine and control-plane: it emits via an injected `emit(topic, payload)`
 * callback rather than importing a bus. Topic names come from `TOPICS` (contracts).
 *
 * On each pushed chunk it advances the per-source segmenter and, for every newly
 * completable segment, emits:
 *   - `media.segment.created` with the `MediaSegment` (opaque storageRef, no bytes)
 *   - `usage.recorded` with a `UsageEvent` accounting the stored bytes (storage)
 *     and the bytes received over the wire (bandwidth) for module 11.
 *
 * No raw credential ever flows through here — live connect is handled by the
 * `SourceRegistry` and the resolved value never escapes that call (FR-6).
 */
import {
  TOPICS,
  UsageEventSchema,
  type AuthContext,
  type CompressionPlan,
  type MediaSegment,
  type UsageEvent,
} from "@gentech/contracts";
import type { SecretsVault, SecretRef } from "@gentech/secrets";
import { SourceRegistry, type LiveProtocol, type SourceRegistration } from "./sources.js";
import { UploadManager, type UploadSession, type ChunkReceipt } from "./upload.js";
import { Segmenter, type SegmenterOptions } from "./segmenter.js";

/** Injected sink — keeps ingestion decoupled from any concrete event bus. */
export type EmitFn = (topic: string, payload: unknown) => void;

const BYTES_PER_GB = 1024 ** 3;

export interface IngestionGatewayOptions {
  vault: SecretsVault;
  emit: EmitFn;
  segmenter?: SegmenterOptions;
}

let usageSeq = 0;
function freshUsageId(): string {
  return `usage_${Date.now().toString(36)}${(++usageSeq).toString(36).padStart(3, "0")}`;
}

interface UploadCtx {
  session: UploadSession;
  segmenter: Segmenter;
  jobId: string;
}

export class IngestionGateway {
  readonly sources: SourceRegistry;
  private readonly uploads = new UploadManager();
  private readonly emit: EmitFn;
  private readonly vault: SecretsVault;
  private readonly segOpts?: SegmenterOptions;
  private readonly ctxBySession = new Map<string, UploadCtx>();

  constructor(opts: IngestionGatewayOptions) {
    this.vault = opts.vault;
    this.emit = opts.emit;
    this.segOpts = opts.segmenter;
    this.sources = new SourceRegistry(this.vault);
  }

  /** Register a live (RTSP/ONVIF/HLS) or upload source (FR-1). */
  registerSource(
    input:
      | { kind: "live"; tenantId: string; protocol: LiveProtocol; uri: string; secretRef?: SecretRef; compression?: CompressionPlan }
      | { kind: "upload"; tenantId: string; compression?: CompressionPlan },
  ): SourceRegistration {
    if (input.kind === "live") {
      return this.sources.registerLive(input);
    }
    return this.sources.registerUpload(input);
  }

  /**
   * Open a resumable upload session for a registered source (FR-2). `jobId` ties
   * emitted usage to a billable job; defaults to the session id when absent.
   */
  openUpload(args: { sourceId: string; tenantId: string; jobId?: string; sessionId?: string }): UploadSession {
    const reg = this.sources.get(args.sourceId);
    const session = this.uploads.open({ sourceId: args.sourceId, tenantId: args.tenantId, sessionId: args.sessionId });
    const segmenter = new Segmenter(args.tenantId, args.sourceId, this.segOpts, reg?.compression);
    this.ctxBySession.set(session.sessionId, { session, segmenter, jobId: args.jobId ?? session.sessionId });
    return session;
  }

  /** Declare the finite chunk count so the final segment can be marked (FR-5). */
  finalizeUpload(sessionId: string, totalChunks: number): MediaSegment[] {
    const ctx = this.requireCtx(sessionId);
    ctx.session.finalize(totalChunks);
    return this.drain(ctx, 0);
  }

  /**
   * Push one chunk (idempotent, out-of-order tolerant — FR-2). Returns the
   * segments emitted as a side effect of this chunk arriving (progressive — FR-4).
   */
  pushChunk(sessionId: string, index: number, bytes: Uint8Array): { receipt: ChunkReceipt; segments: MediaSegment[] } {
    const ctx = this.requireCtx(sessionId);
    const receipt = ctx.session.put(index, bytes);
    // Only newly-received bytes count toward bandwidth; duplicates are free.
    const wireBytes = receipt.duplicate ? 0 : receipt.bytes;
    const segments = this.drain(ctx, wireBytes);
    return { receipt, segments };
  }

  private requireCtx(sessionId: string): UploadCtx {
    const ctx = this.ctxBySession.get(sessionId);
    if (!ctx) throw new Error(`unknown upload session ${sessionId}`);
    return ctx;
  }

  /**
   * Advance the segmenter over the contiguous bytes seen so far and emit events
   * for any newly completable segment. `wireBytes` is the bandwidth to attribute
   * to this drain (the bytes that just arrived).
   */
  private drain(ctx: UploadCtx, wireBytes: number): MediaSegment[] {
    const segments = ctx.segmenter.advance(ctx.session.contiguousCount(), ctx.session.isComplete());
    let firstSegmentBilledWire = false;
    for (const seg of segments) {
      this.emit(TOPICS.mediaSegmentCreated, seg);
      // Storage: bytes persisted for this segment's window (a slice of totalBytes).
      // Bandwidth is attributed once per drain to avoid double counting.
      const storedBytes = this.storedBytesFor(ctx.session, seg);
      const usage = this.makeUsage(ctx, seg, storedBytes, firstSegmentBilledWire ? 0 : wireBytes);
      firstSegmentBilledWire = true;
      this.emit(TOPICS.usageRecorded, usage);
    }
    return segments;
  }

  /** Approximate stored bytes for a segment by even share of received bytes. */
  private storedBytesFor(session: UploadSession, _seg: MediaSegment): number {
    const chunks = session.receivedChunks.size || 1;
    return Math.round(session.totalBytes / chunks);
  }

  private makeUsage(ctx: UploadCtx, seg: MediaSegment, storedBytes: number, wireBytes: number): UsageEvent {
    return UsageEventSchema.parse({
      usageId: freshUsageId(),
      tenantId: seg.tenantId,
      jobId: ctx.jobId,
      gpuSeconds: 0, // ingestion does no GPU work
      gpuClass: "none",
      storageGbHours: storedBytes / BYTES_PER_GB,
      bandwidthGb: wireBytes / BYTES_PER_GB,
      ts: new Date().toISOString(),
    });
  }
}
