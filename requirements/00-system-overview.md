# 00 — System Overview

GenTech AI is a cloud-native, agentic platform for large-scale video intelligence: users connect cameras
or upload video, express analytical objectives in natural language, and the system dynamically builds and
runs optimized computer-vision pipelines, rendering results through an adaptive generative UI.

This document is the map. It defines the module set, how they depend on each other, the v1 delivery
boundary (what's real vs mocked), the global non-functional requirements, and the future roadmap. Each
module's detailed contracts live in its own `NN-*.md` file; all shared types live in
[`00-shared-contracts.md`](./00-shared-contracts.md).

---

## Module set

| # | Module | One-line responsibility |
|---|---|---|
| 01 | Ingestion & Stream Gateway | Connect RTSP/ONVIF/HLS + uploads; emit `MediaSegment`s progressively. |
| 02 | Credential & Secrets Vault | Hash/tokenize/store creds; runtime ephemeral, tenant-isolated retrieval. |
| 03 | Agentic Orchestrator | NL `Query` → real `PipelineSpec` DAG (model selection, topology, retries). |
| 04 | Pipeline Execution Engine | Run the DAG; fan-out, checkpoint, recover; emit `ResultEvent`s. |
| 05 | Compute Provisioning & GPU Scheduler | GPU inventory, leases, priority/budget-aware scheduling. |
| 06 | Vision Model Registry & Inference | Model catalog + capability metadata; standardized inference interface. |
| 07 | Preset Pipelines & Continuous Streams | Preset workflows; long-running stream jobs; alerting; windowed analytics. |
| 08 | Frontend App & Generative UI | v1 web app (7 screens) + generative-UI chat + thin desktop uploader. |
| 09 | Content Safety & Query Validation | NSFW/moderation; validate NL queries against capabilities/permissions/compliance. |
| 10 | Multi-Tenant Governance & IAM | Tenant isolation, RBAC/ABAC, scoped actions, compute governance. |
| 11 | Billing, Cost & Budget | Usage metering, dynamic pricing, pre-run cost estimate, budget enforcement. |
| 12 | Observability, Reliability & Control Plane | Audit/traces, health, circuit breakers, public API gateway + event bus. |
| 13 | Mock Server (v1 fake backend) | Invents model outputs + GPU/infra state behind the real contracts. |

---

## Dependency graph

```
                          ┌─────────────────────────────┐
                          │ 12 Control Plane / API GW    │  (fronts all external calls;
                          │    + Event Bus + Observ.     │   collects traces from everyone)
                          └──────────────┬──────────────┘
                                         │
        ┌────────────────────────────────┼────────────────────────────────────┐
        ▼                                ▼                                      ▼
┌───────────────┐                ┌───────────────┐                     ┌───────────────┐
│ 08 Frontend / │  query.submit  │ 09 Safety &   │   valid query       │ 03 Agentic    │
│  Generative   │ ─────────────► │  Query Valid. │ ──────────────────► │ Orchestrator  │
│  UI (chat)    │ ◄───────────── └───────────────┘                     └──────┬────────┘
└──────┬────────┘  UISpec/results        ▲                                    │ PipelineSpec
       │                                 │ authorize()                        ▼
       │ connect camera /     ┌──────────┴─────────┐              ┌────────────────────┐
       │ upload               │ 10 IAM / Governance│◄────────────►│ 04 Pipeline Exec   │
       ▼                      │   (AuthContext)    │   priority   │   Engine (DAG run) │
┌───────────────┐            └──────────┬─────────┘              └───┬───────┬────────┘
│ 01 Ingestion  │ secretRef             │                            │       │
│  & Gateway    │ ────────►┌────────────▼───┐         ComputeRequest │       │ InferenceRequest
│               │          │ 02 Secrets     │     ┌──────────────────▼─┐   ┌─▼──────────────┐
└──────┬────────┘          │  Vault         │     │ 05 GPU Scheduler   │   │ 06 Model       │
       │ MediaSegment      └────────────────┘     │  (leases,inventory)│   │ Registry+Infer │
       │                                          └─────────┬──────────┘   └─┬──────────────┘
       │                                            UsageEvent│               │ (v1: outputs
       ▼                                                      ▼               │  & inventory
┌───────────────┐   preset → PipelineSpec            ┌────────────────┐       │  come from 13)
│ 07 Presets /  │ ─────────────────────────────────► │ 11 Billing /   │◄──────┘
│  Continuous   │ ◄───────── budget.threshold ────── │  Cost / Budget │
└───────────────┘                                    └────────────────┘
                         ┌──────────────────────────────────────────────┐
                         │ 13 Mock Server — stands in for 05/06 outputs   │
                         │ + 01 inference, on the SAME contracts (v1 only)│
                         └──────────────────────────────────────────────┘
```

**Reading the edges (each must match a contract in `00-shared-contracts.md`):**
- 08 → 09 → 03: `query.submitted` (`Query`) is validated, then orchestrated.
- 03 → 04: `pipeline.created` (`PipelineSpec`).
- 04 → 05: `ComputeRequest` → `WorkerLease`. 04 → 06/13: `InferenceRequest` → `InferenceResponse`.
- 04 → 08: `result.event` (`ResultEvent`) → render agent → `UISpec`.
- 01 → 04: `media.segment.created` (`MediaSegment`). 01 → 02: `SecretRef` resolution.
- 05/04 → 11: `usage.recorded` (`UsageEvent`). 11 → 03/05/08: `budget.threshold` (`BudgetPolicy`).
- 10 ↔ all: `AuthContext` + `authorize()`. 12 ↔ all: trace/decision/DLQ topics.

No cycles in the data plane (it's a DAG end-to-end); the only bidirectional edges are the cross-cutting
control concerns (IAM, observability, budget signals).

---

## Real vs. mocked boundary (v1)

**Intelligence is real; GPUs/CV/pixels are faked.** See per-module "v1: mock vs real" sections for detail.

| Real in v1 | Mocked by module 13 |
|---|---|
| 03 orchestration (NL → real DAG) | Model outputs: detections, tracks, embeddings, ANPR, NSFW |
| 04 DAG execution/state machine (work itself is mock) | GPU inventory, VRAM, running jobs, queue depth, leases |
| 06 registry metadata (selection & cost) | The inference call itself |
| 08 full app + generative-UI chat | Pixel decode in 01 (segments are accepted, never decoded) |
| 09 query validation logic | Pixel-level NSFW/moderation scoring |
| 10 auth/roles, 11 cost math | Real provisioning in 05 (leases simulated) |

Swap-in path: each real module reads mocked data through the *same* contract, so going live = pointing one
client at a real endpoint instead of module 13. No contract changes required.

---

## Global non-functional requirements

Derived from source doc "Desired Architectural Characteristics" (lines 529–544) and "Cloud Compatibility"
(515–527). These apply to every module unless a module file overrides with a tighter budget.

- **Modular & extensible** — modules communicate only via the contracts in `00-shared-contracts.md`; no shared DB tables across module boundaries.
- **Event-driven** — state changes propagate via the canonical topics (§8 of shared contracts); request/response only where synchronous answers are required (auth, cost estimate, lease).
- **Horizontally scalable** — every module is stateless or shards by `tenantId`; no per-instance affinity.
- **GPU-aware** — compute requests always carry `gpuClass`/VRAM hints; CPU-only paths are first-class.
- **Fault-tolerant** — retries + DLQ + checkpointing (module 04); circuit breakers + health (module 12); graceful degradation (lower FPS/resolution/lightweight models) instead of hard failure.
- **Cost-aware** — no job runs without a `CostEstimate` and a budget check (modules 11/10).
- **Multi-tenant & secure-by-default** — every request carries `AuthContext`; tenant isolation across data, creds, compute, logs, billing (module 10); credentials never stored raw (module 02).
- **Cloud-agnostic** — no module names a specific cloud SDK in its contract; cloud-specific bits (secrets manager, object store, GPU provider, broker) sit behind adapter interfaces. Deployable to AWS/GCP/Azure/hybrid/on-prem.
- **Real-time capable** — progressive results (`partial:true`) and live segment processing are required, not optional.

---

## Roadmap (post-v1, from source doc "Advanced Enhancements" 546–562)

Tracked here, not specced as modules yet. Each maps to an owning module when scheduled:
- Self-optimizing pipelines, RL-based scheduling → 03/05
- Model auto-selection, auto-quantization, adaptive frame skipping → 03/06
- Semantic caching, vector-based event retrieval, cross-camera tracking → 04/06/07
- Federated edge inference, hybrid edge/cloud orchestration, predictive autoscaling → 05
- AI-generated pipeline explanations → 03 (the `PipelineSpec.explanation` field already reserves space)

---

## How to use these files

1. Read this overview + `00-shared-contracts.md` first.
2. Pick a module file (`01`–`13`). Each is self-contained: purpose, scope, contracts, dependencies, FRs, NFRs, v1 mock-vs-real, open decisions, acceptance criteria.
3. A module can be planned/built by reading only its file + the two `00-*` files.
