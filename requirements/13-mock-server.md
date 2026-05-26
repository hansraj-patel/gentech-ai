# 13 — Mock Server (v1 fake backend)

> Shared types: see [`00-shared-contracts.md`](./00-shared-contracts.md). Source: the "Real vs. mocked
> boundary" section of [`00-system-overview.md`](./00-system-overview.md) (no source-doc lines — this is
> the v1 delivery scaffold, not a product feature).

## 1. Purpose
A single authoritative fake backend that lets the **real** intelligence + UI layers run end-to-end without
any GPUs, CV models, or pixel processing. It invents two things, behind the *same contracts* the real
modules use: **(1) model outputs** (detections, tracks, embeddings, ANPR/OCR, NSFW scores) and **(2) GPU/
infra state** (inventory, VRAM, running jobs, queue depth, lease feasibility). Because it speaks the real
contracts, going live later = pointing one client at a real endpoint instead of the mock — no contract
changes.

## 2. In scope / Out of scope
**In:** serve `POST /infer` (stands in for module 06); serve `GpuInventory` + lease feasibility (stands in
for module 05's physical layer); a **time-simulation engine** that advances jobs through stages, fluctuates
GPU availability, and fires alerts on a simulated clock; **scenario** + **fixture** + **seeded-RNG** data
generation; a control panel to pick scenario/seed/speed.
**Out:** any real CV/GPU/video work; any business logic that belongs to a real module (the orchestrator,
scheduler logic, cost math, validation all stay in their own modules and merely *read* from here).

## 3. Inbound contracts (it impersonates real endpoints)
- `POST /infer` — accepts `InferenceRequest`, returns a schema-valid `InferenceResponse` (synthetic, keyed by `segmentId`+`modelId`+seed). *(impersonates module 06)*
- `GET /compute/inventory` — returns a `GpuInventory` that fluctuates over the simulated clock. *(feeds module 05)*
- `POST /compute/lease-feasibility` — given a `ComputeRequest`, returns whether a lease is grantable now + a mock `endpoint`. *(feeds module 05)*
- Control API: `POST /mock/scenario` `{scenarioId, seed, speed}`, `POST /mock/advance`, `GET /mock/state`.

## 4. Outbound contracts
- None of its own business events; it **responds** to 04/05/06/09 calls and optionally drives a simulated
  clock that causes real modules to emit real `job.status.changed` / `result.event` / `alert.raised`.

## 5. Core data models (owned)
```jsonc
Scenario {
  scenarioId: string, name: string,           // "parking_lot_daytime","gate_intrusion_night",...
  sources: { sourceId: SourceId, profile: string }[],
  // deterministic "ground truth" the mock derives outputs from:
  groundTruth: {
    detections?: { segmentRange:[number,number], label:string, count:number, attrs?:{} }[],
    tracks?: { trackId:string, label:string, path:any }[],
    anpr?: { plate:string, atSegment:number }[],
    events?: { kind:string, atTime:number }[]   // drives alerts
  },
  infra: { gpuTotals:{[cls:string]:number}, loadProfile:"steady"|"bursty"|"scarce" }
}
SimClock { tNow:number, speed:number, runningJobs:JobId[] }
```
Fixtures: static JSON files per scenario (hand-editable) that seed `groundTruth`.

## 6. Module dependencies
**Consumed by:** 04 (infer), 05 (inventory/leases), 06 (proxies `/infer` to here), 09 (NSFW score), 11
(GPU-seconds/pricing inputs). **Depends on:** nothing (it's a leaf).

## 7. Functional requirements
- **FR-1** Return synthetic but **plausible & schema-valid** `InferenceResponse`s for every task: object detection (e.g. white cars), classification, color, tracking, embeddings, ANPR/OCR text, NSFW score. *(model outputs)*
- **FR-2** Outputs are **derived from the scenario's `groundTruth`** so that, e.g., "how many white cars" returns the scenario's intended count — making demos coherent end-to-end, not random noise.
- **FR-3** **Seeded randomness**: same `{scenario, seed}` → reproducible outputs, with light jitter so repeated runs look alive. Default mode = **scripted scenarios + seeded randomness**; also support **pure-fixture replay** (fully deterministic).
- **FR-4** Serve a fluctuating `GpuInventory` (available counts, VRAM, running jobs, queue depth) per the scenario's `loadProfile`, so the scheduler (05) and cost (11) have realistic, changing inputs.
- **FR-5** Grant/deny lease feasibility consistent with current mock inventory (so scarcity scenarios actually deprioritize work).
- **FR-6** **Time simulation (on by default)**: advance jobs through DAG stages with realistic per-node delays, drift GPU availability, and fire scenario `events` so monitors/alerts (07) trigger on the simulated clock — exercising progressive `partial` results and live UI.
- **FR-7** Control surface to select scenario, seed, and clock speed; advance/pause; inspect state — for demos and tests.
- **FR-8** Latency simulation: report believable `latencyMs` per model from registry metadata (06) so traces/cost look real.

## 8. Non-functional requirements
- Single deployable service; no GPU/heavy deps; starts in seconds.
- **Contract-faithful**: every response validates against the exact shared-contract schema the real module would return (enforced by schema tests) — this is the property that guarantees clean swap-in.
- Deterministic under a fixed seed (for CI/E2E tests); lively under time-sim (for demos).

## 9. v1: mock vs real
This module **is** the mock — it has no real counterpart. At go-live it is **deleted/disabled** and the
real modules (05 physical provisioning, 06 inference) take over the same endpoints. Nothing else changes.

## 10. Open decisions
Scenario authoring format (JSON vs YAML); how many seed scenarios to ship; whether the clock is push (server drives) or pull (clients advance); fixture storage location.

## 11. Acceptance criteria
- Selecting the "parking_lot_daytime" scenario and running the "white cars" query yields the scenario's intended count, reproducibly under a fixed seed.
- Every `/infer` response and `GpuInventory` validates against the shared-contract schemas (automated schema test).
- With time-sim on, a job's DAG visibly progresses stage-by-stage and at least one monitor fires an alert on the simulated clock.
- Swapping the `/infer` base URL from mock to a stub "real" endpoint requires zero changes in modules 04/06 (proves contract-faithfulness).
