/**
 * @gentech/ingestion (module 01) — ingestion & stream gateway.
 *
 * Public API: register live/upload sources, run resumable chunked uploads, and
 * progressively segment arriving bytes into `MediaSegment`s with a monotonic
 * index + opaque storageRef, emitting `media.segment.created` and storage/
 * bandwidth `usage.recorded` events via an injected emit callback.
 *
 * v1 "intelligence real, pixels faked": real registration / upload / segmentation
 * / credential resolution bookkeeping; bytes are opaque (no pixel decode).
 */
export * from "./sources.js";
export * from "./upload.js";
export * from "./segmenter.js";
export * from "./gateway.js";
