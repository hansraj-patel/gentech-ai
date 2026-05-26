# 01 — Ingestion & Stream Gateway

> Shared types: see [`00-shared-contracts.md`](./00-shared-contracts.md). Source lines: 39–96, 80–96.

## 1. Purpose
Connect the platform to every video input — live cameras (RTSP/ONVIF/HLS) and uploads (compressed and
high-quality, chunked) — and turn each into a uniform stream of `MediaSegment`s that downstream modules
can process **progressively, before the full upload/stream completes**.

## 2. In scope / Out of scope
**In:** source registration & health; protocol connectors (RTSP/ONVIF/HLS); chunked + streaming uploads;
desktop-side compression negotiation; segmentation into `MediaSegment`s; emitting `media.segment.created`;
storing bytes to object storage and returning `storageRef`s.
**Out:** decoding/running models on frames (04/06); storing credentials (02 — this module only holds a
`SecretRef`); deciding *what* analysis to run (03).

## 3. Inbound contracts
- `POST /sources` — register a `MediaSource` (live or upload). Body: kind + connection metadata + optional `SecretRef`. Returns `SourceId`.
- `POST /sources/{id}/uploads` — begin a chunked/streaming upload session. Returns upload URL/token.
- `PUT /uploads/{session}/chunks/{index}` — resumable chunk upload (out-of-order allowed).
- `GET /sources/{id}/health` — current `MediaSource.health`.
- Consumes: `CompressionPlan` from orchestrator (03) during upload negotiation.

## 4. Outbound contracts
- Emits `media.segment.created` (`MediaSegment`) per segment, `final:true` on the last.
- Calls module 02 `resolve(SecretRef, AuthContext)` to obtain `EphemeralCredential` for live connect.
- Emits `usage.recorded` for storage/bandwidth (`UsageEvent`).
- Emits `TraceSpan` (module 12).

## 5. Core data models (owned)
`MediaSource`, `MediaSegment`, `CompressionPlan` — defined in shared contracts §2.

## 6. Module dependencies
**Upstream:** 02 (secrets), 03 (compression plan), 10 (`AuthContext`). **Downstream:** 04 (consumes segments), 11 (usage).

## 7. Functional requirements
- **FR-1** Register RTSP, ONVIF (host/port/profile), and HLS sources; validate reachability via a test-connect that uses an ephemeral credential. *(45–48)*
- **FR-2** Accept compressed and uncompressed uploads; support **chunked/resumable** uploads for large files. *(49–55)*
- **FR-3** Desktop app negotiates a `CompressionPlan` with the agent (03); only the resulting downscaled stream is uploaded. *(52)*
- **FR-4** Begin segmentation + emit segments **as upload/stream arrives** (progressive), not after completion. *(80–96)*
- **FR-5** Segment by temporal window; mark `final` on stream end; guarantee monotonic `index` per source.
- **FR-6** Never persist raw credentials; hold only `SecretRef`; resolve at connect time and discard by `expiresAt`. *(57–69)*
- **FR-7** Report source health (online/degraded/offline) and surface it via `GET health`.

## 8. Non-functional requirements
- First `MediaSegment` emitted within ≤ 2× segment-duration of bytes arriving (early-inference enablement).
- Tenant-isolated storage prefixes; `storageRef`s are tenant-scoped and unguessable.
- Backpressure: if downstream lags, buffer to storage, never drop a `final` segment.

## 9. v1: mock vs real
**Real:** source registration, upload sessions, chunking, segmentation, `storageRef` creation, health, `SecretRef` resolution, emitting `media.segment.created`. **Mocked:** no pixel decode — bytes are stored and segment descriptors emitted, but frames are never actually decoded; module 13 supplies all inference outputs keyed by `segmentId`.

## 10. Open decisions
Object store (S3/GCS/Azure Blob behind an adapter); broker for segment events; segmentation strategy (fixed window vs GOP-aligned); desktop app transport (gRPC/HTTP resumable).

## 11. Acceptance criteria
- Register one of each source kind; a streaming upload emits ≥1 `MediaSegment` before the upload finishes.
- Killing an upload mid-way and resuming continues from the last acked chunk.
- No raw credential is ever written to storage or logs (grep/audit check).
