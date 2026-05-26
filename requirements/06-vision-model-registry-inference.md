# 06 — Vision Model Registry & Inference

> Shared types: see [`00-shared-contracts.md`](./00-shared-contracts.md). Source lines: 122–154, 135–138, 243–245.

## 1. Purpose
Be the catalog of available vision models and the **single standardized inference interface**. Holds
capability metadata the orchestrator (03) uses for model selection and billing (11) uses for cost, and
serves inference via a uniform `InferenceRequest`/`InferenceResponse` contract. In v1 the **registry
metadata is real**; the inference call is served by the mock server.

## 2. In scope / Out of scope
**In:** model catalog + versioning; capability metadata (task, VRAM, latency, accuracy, cost weight);
standardized inference endpoint; model→task mapping; NSFW/moderation model entries.
**Out:** choosing which model to use (03); running the DAG (04); allocating GPUs (05).

## 3. Inbound contracts
- `GET /models` / `GET /models/{id}` — catalog + `ModelMetadata`.
- `GET /models?task=object_detection` — filter by capability (used by 03).
- `POST /infer` — body `InferenceRequest`. Returns `InferenceResponse`. (v1: proxied to module 13.)

## 4. Outbound contracts
- Emits model-invocation logs (`trace.span` w/ `module:"infer"`) → 12.
- Emits `usage.recorded` contribution for model compute (combined with 05's gpu-seconds).

## 5. Core data models (owned)
```jsonc
ModelMetadata {
  modelId: ModelId, name: string, version: string,
  tasks:   string[],            // ["object_detection"], ["anpr","ocr"], ["tracking"], ["nsfw"]
  minVramGb: number, cpuCapable: boolean,
  typicalLatencyMs: number, accuracy?: number,
  costWeight: number,           // multiplier used by module 11
  outputKinds: InferenceResponse-field[]  // which response fields it populates
}
```
Plus `InferenceRequest`/`InferenceResponse` — shared contracts §5.

## 6. Module dependencies
**Upstream:** 10 (`AuthContext`). **Downstream:** 03 (selection), 04 (inference), 11 (cost weights), 12 (logs). v1: 13 (serves `/infer`).

## 7. Functional requirements
- **FR-1** Catalog detection (YOLO-family), classification (vehicle/color), ANPR/OCR, tracking, embeddings, and NSFW/moderation models. *(122–154, 135–138, 364–366)*
- **FR-2** Expose capability metadata (VRAM, latency, cpuCapable, accuracy, costWeight) so 03 can pick and 11 can price. *(243–245)*
- **FR-3** Standardized inference contract: every model, regardless of task, is called via `POST /infer` and returns the shared `InferenceResponse`. *(135–138)*
- **FR-4** Versioning: a `modelId` pins a version; selection can request "latest" or a specific version.
- **FR-5** Map tasks→models so the orchestrator can query "models for task X".

## 8. Non-functional requirements
- Catalog reads p99 ≤ 30 ms (on the orchestration hot path).
- Inference contract is identical between real (06) and mock (13) so callers are agnostic.

## 9. v1: mock vs real
**Real:** the registry/catalog, metadata, versioning, task mapping (this is what makes 03's selection and
11's pricing genuine). **Mocked:** `POST /infer` is fulfilled by module 13, which returns synthetic
detections/tracks/embeddings/OCR/NSFW conforming to `InferenceResponse`.

## 10. Open decisions
Serving runtime when going real (KServe/Triton/vLLM-for-VLM/TGI); model storage/registry backend; auto-quantization & model auto-selection (roadmap).

## 11. Acceptance criteria
- `GET /models?task=anpr` returns appropriate model(s) with VRAM/latency metadata.
- `POST /infer` returns a schema-valid `InferenceResponse` for each task type (via mock in v1).
- 03 can select and 11 can price using only registry metadata (no hidden inference-time surprises).
