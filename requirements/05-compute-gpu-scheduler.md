# 05 — Compute Provisioning & GPU Scheduler

> Shared types: see [`00-shared-contracts.md`](./00-shared-contracts.md). Source lines: 171–269, 312–325.

## 1. Purpose
Decide *where* and *on what* each pipeline node runs. Maintain GPU/compute inventory, grant `WorkerLease`s,
provision ephemeral workers on demand and tear them down after, and schedule with awareness of priority,
budget, GPU class/VRAM, and queue pressure. In v1 the **scheduling logic is real** but inventory and leases
are simulated via the mock server.

## 2. In scope / Out of scope
**In:** GPU inventory tracking; lease grants; GPU-class/VRAM selection; CPU-only decisions; priority &
budget-aware queues; tenant prioritization; spot/reserved/on-demand strategy; autoscaling + teardown;
emitting compute `UsageEvent`s.
**Out:** what work runs (04); pricing (11 — this module reports usage, 11 prices it); model metadata (06).

## 3. Inbound contracts
- `POST /compute/lease` — body `{ ComputeRequest, jobId, AuthContext }`. Returns `WorkerLease` or queues.
- `POST /compute/release` — release a lease (triggers teardown if ephemeral).
- `GET /compute/inventory` — `GpuInventory` snapshot.
- Consumes `budget.threshold` (deprioritize/deny over-budget tenants).

## 4. Outbound contracts
- Emits `compute.lease.granted` (`WorkerLease`), `usage.recorded` (`UsageEvent`), `trace.span`/`decision.logged`.
- In v1, reads inventory + lease feasibility from module 13.

## 5. Core data models (owned)
`WorkerLease`, `GpuInventory`, `ComputeRequest` (consumed) — shared contracts §6.

## 6. Module dependencies
**Upstream:** 04 (requests), 10 (priority/governance), 11 (budget). **Downstream:** 04 (leases), 11 (usage). v1: 13 (inventory).

## 7. Functional requirements
- **FR-1** Choose target compute from `ComputeRequest`: smaller GPU for lightweight YOLO, higher-end for multi-stage OCR/tracking; allow CPU-only when acceptable. *(232–245)*
- **FR-2** **Dynamic provisioning** based on query complexity, required models, SLA, queue pressure, available inventory; ephemeral workers; automatic teardown after completion. *(213–228)*
- **FR-3** GPU autoscaling considering fragmentation, cost optimization, thermal/load balancing, reserved capacity, spot utilization. *(225–252)*
- **FR-4** **Priority queues + tenant prioritization + budget-aware execution**; deprioritize low-value workloads; high-priority cameras run first, low-priority only on spare compute. *(256–269)*
- **FR-5** **Smart prioritization**: time-of-day, region/hotspot, SLA-aware, budget-aware scheduling (e.g. entrance cameras prioritized at night; parking-lot analytics deprioritized when budget constrained). *(312–325)*
- **FR-6** Leases are time-bounded (`expiresAt`); expired leases are reclaimed.
- **FR-7** Tenant compute isolation: per-tenant queues / dedicated pools where governance (10) requires it. *(398–404)*

## 8. Non-functional requirements
- Lease decision latency p95 ≤ 200 ms.
- No starvation: low-priority work eventually runs (aging).
- Inventory view is eventually-consistent but never grants beyond capacity.

## 9. v1: mock vs real
**Real:** lease API, queueing, priority/budget/time-of-day scheduling logic, teardown bookkeeping, usage
emission. **Mocked:** `GpuInventory` (counts, VRAM, running jobs, queue depth) and physical provisioning
come from module 13; no real GPUs are allocated — `WorkerLease.endpoint` points at the mock worker.

## 10. Open decisions
Orchestrator backend (K8s + KServe / Ray / Run:AI / Slurm / Modal / Firecracker microVMs); spot vs reserved policy; fragmentation/bin-packing algorithm; dedicated-pool vs shared with quotas.

## 11. Acceptance criteria
- A lightweight node gets a `small`/CPU lease; a heavy OCR+tracking node gets `large` — visible in lease decisions.
- Under simulated scarcity, a high-priority tenant's job leases before a low-priority one; the low-priority job still eventually runs.
- On `budget.threshold` for a tenant, new leases for that tenant are deprioritized or denied.
