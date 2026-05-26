# 04 — Pipeline Execution Engine

> Shared types: see [`00-shared-contracts.md`](./00-shared-contracts.md). Source lines: 156–211, 196–211, 432–443.

## 1. Purpose
Execute a `PipelineSpec` DAG reliably and at scale: schedule nodes respecting dependencies, fan video
chunks out across workers, run inference per node, aggregate outputs into `ResultEvent`s, and survive
failure via retries/checkpointing/DLQ/partial recovery. In v1 the **orchestration is real** but each node
fetches outputs from the mock server instead of doing real CV/GPU work.

## 2. In scope / Out of scope
**In:** DAG scheduling (topological, parallel where allowed); chunk fan-out + result aggregation; calling
06/13 for inference and 05 for leases; `JobStatus` lifecycle; progressive/partial `ResultEvent` emission;
retries, dead-letter, checkpointing, partial recovery; emitting usage.
**Out:** building the DAG (03); owning GPU inventory (05); the model math (06/13); rendering (08).

## 3. Inbound contracts
- Consumes `pipeline.created` (`PipelineSpec`) → creates a `JobId`.
- Consumes `media.segment.created` (`MediaSegment`) → routes segments to runnable nodes.
- `POST /jobs/{id}/cancel`, `GET /jobs/{id}` (`JobStatus`).

## 4. Outbound contracts
- Calls 05 `lease(ComputeRequest)` → `WorkerLease`; sends `InferenceRequest` to lease `endpoint` (06 real, 13 mock).
- Emits `job.status.changed` (`JobStatus`), `result.event` (`ResultEvent`), `usage.recorded` (`UsageEvent`).
- Failures past `RetryPolicy` → `dlq.failed` (`Event<Error>`). Emits `trace.span` per node.

## 5. Core data models (owned)
`JobStatus`, `ResultEvent`, `InferenceRequest` — shared contracts §4–5.

## 6. Module dependencies
**Upstream:** 03 (spec), 01 (segments), 05 (leases), 06/13 (inference), 10 (`AuthContext`). **Downstream:** 08 (results), 11 (usage), 12 (traces/DLQ).

## 7. Functional requirements
- **FR-1** Execute the DAG honoring edges: run independent nodes in parallel, dependent nodes in order. *(156–169)*
- **FR-2** **Parallel video processing**: split large media into chunks (temporal + spatial), distribute across workers, process concurrently, with frame batching and adaptive sampling. *(196–211)*
- **FR-3** **Early/progressive inference**: start processing arriving segments immediately; emit `partial:true` `ResultEvent`s and finalize when the job completes. *(80–96, 301–309)*
- **FR-4** Acquire a `WorkerLease` from 05 before running a node; release/teardown on completion. *(213–228)*
- **FR-5** Reliability: automatic retries (per `RetryPolicy`), **dead-letter queue**, **checkpointing**, **partial pipeline recovery**, circuit breakers on failing nodes. *(432–443)*
- **FR-6** **Graceful degradation**: under constraint, reduce FPS/resolution, switch to lightweight models, or defer non-critical nodes rather than failing the job (state → `degraded`). *(419–428)*
- **FR-7** Emit accurate `UsageEvent`s (gpu-seconds per node/class) for billing. *(445–456)*
- **FR-8** Maintain `JobStatus` with per-node states and overall progress; support cancel.

## 8. Non-functional requirements
- Linear-ish throughput scaling with worker count for parallelizable nodes.
- Exactly-once result aggregation (no double-count) even under retries.
- A single node failure never loses completed upstream results (checkpointing).

## 9. v1: mock vs real
**Real:** DAG scheduler, chunk fan-out, aggregation, `JobStatus` state machine, retries/DLQ/checkpoint/
recovery logic, progressive emission, usage accounting. **Mocked:** the `InferenceRequest` goes to module
13, which returns synthetic `InferenceResponse`s; stage timing is simulated by 13's time model so the DAG
visibly progresses in the UI.

## 10. Open decisions
Workflow engine (Temporal/Prefect/Dagster/Ray) vs custom; checkpoint store; chunking heuristics; batching/sampling policy; circuit-breaker thresholds.

## 11. Acceptance criteria
- A multi-node DAG runs parallel branches concurrently and respects dependency edges (observable in traces).
- Injecting a node failure triggers retry, then DLQ after exhaustion, without losing prior results.
- A long upload yields `partial:true` results before the final segment, then a `succeeded` job with finalized results.
