# 03 — Agentic Orchestrator

> Shared types: see [`00-shared-contracts.md`](./00-shared-contracts.md). Source lines: 99–169, 288–299.

## 1. Purpose
The central intelligence layer. Takes a validated natural-language `Query`, understands intent, and
**dynamically generates an optimized processing pipeline** as a DAG (`PipelineSpec`): selecting tasks and
models, ordering stages, marking parallelism, attaching compute hints and a retry policy. This is **real
in v1** — whatever the user types produces a real pipeline.

## 2. In scope / Out of scope
**In:** intent understanding; mapping intent → required CV tasks; model selection from registry metadata
(06); DAG construction (nodes/edges, sequential vs parallel); per-node `ComputeRequest` hints; retry
policy; compression-target decision for uploads; NL pipeline explanations.
**Out:** running the pipeline (04); provisioning compute (05); validating safety/permissions (09/10 — the
orchestrator is invoked only *after* validation passes); rendering results (08).

## 3. Inbound contracts
- `POST /orchestrate` — body `{ Query, AuthContext }` (called after 09 validation). Returns `PipelineSpec` + `CostEstimate` (delegates estimate to 11).
- `POST /compression-plan` — body `{ MediaSource (upload), Query? }`. Returns `CompressionPlan` for module 01 / desktop app.
- Consumes `query.submitted` (post-validation) and `budget.threshold` (to downgrade pipelines under budget pressure).

## 4. Outbound contracts
- Emits `pipeline.created` (`PipelineSpec`).
- Calls 06 registry to read model capability metadata; calls 11 for `CostEstimate`.
- Emits `decision.logged` (why this pipeline / which models / topology) for audit (12).

## 5. Core data models (owned)
`Query`, `PipelineSpec`, `PipelineNode`, `RetryPolicy` — shared contracts §4.

## 6. Module dependencies
**Upstream:** 09 (validated query), 10 (`AuthContext`), 06 (model metadata), 11 (estimate). **Downstream:** 04 (executes spec), 01 (compression plan).

## 7. Functional requirements
- **FR-1** Parse NL intent and map to required tasks. E.g. "How many white cars?" → detection → vehicle classification → color classification → counting. *(122–139)*
- **FR-2** Build a **DAG**: declare which nodes are sequential, which parallel, and inter-stage dependencies. Output MUST be acyclic. *(156–169)*
- **FR-3** Select a `modelId` per node from registry metadata, honoring `Query.constraints` (quality/latency/cost). E.g. lightweight YOLO for simple detection, heavier stack for OCR+tracking. *(135–138, 243–245)*
- **FR-4** Attach a `ComputeRequest` per node (gpuClass/VRAM/CPU-ok/priority) as the scheduling hint. *(162–166)*
- **FR-5** Example pipelines must be reproducible: vehicle counting *(122–139)* and number-plate search → vehicle detection → ANPR/OCR → temporal tracking → match filtering *(141–154)*.
- **FR-6** Decide upload compression target (resolution/bitrate/fps) from the query's analytic needs; emit `CompressionPlan` with rationale. *(52)*
- **FR-7** Produce an NL `explanation` of the pipeline (advanced enhancement, reserved field). *(561)*
- **FR-8** On `budget.threshold`, regenerate a cheaper pipeline (lighter models / lower sampling) — graceful degradation. *(312–325, 419–428)*

## 8. Non-functional requirements
- Orchestration latency p95 ≤ 1.5 s for typical queries (it's in the interactive chat path).
- Deterministic given same `Query` + registry snapshot + seed (so the mock demo is reproducible).
- Every decision logged with `traceId` for auditability.

## 9. v1: mock vs real
**Fully real** — intent→DAG, model selection, topology, compute hints, retry policy, explanations are all
genuine. It reads **real metadata** from 06. The only downstream fakery is that 04 executes the DAG against
mock outputs — the orchestrator itself does no mocking.

## 10. Open decisions
LLM/agent framework for intent parsing; capability taxonomy (fixed ontology vs learned); whether model selection is rules-based or a learned policy (RL roadmap item); plan-caching/semantic-cache strategy.

## 11. Acceptance criteria
- The two source-doc example queries produce the documented DAGs (node set + edges + sensible model picks).
- A query with `maxCredits` too low yields a degraded pipeline whose `CostEstimate` fits the cap.
- Generated DAGs are always acyclic; every node has a `modelId` present in the registry.
