# 11 — Billing, Cost & Budget

> Shared types: see [`00-shared-contracts.md`](./00-shared-contracts.md). Source lines: 445–491.

## 1. Purpose
Make cost first-class. Meter usage, price it dynamically, **estimate query cost before execution**, and
enforce budgets (caps, quotas, credits, emergency cutoffs). The pre-run `CostEstimate` is **real in v1** —
it's computed from the real `PipelineSpec` and registry metadata, using the mock's GPU/pricing inputs.

## 2. In scope / Out of scope
**In:** usage metering (`UsageEvent` ingestion); dynamic pricing; pre-execution cost estimation; budget
policies + enforcement signals; credit accounting; emitting `budget.threshold`.
**Out:** compute limits/priority rights (10 — governance owns *who may*, billing owns *how much it costs*);
scheduling (05); actual provisioning.

## 3. Inbound contracts
- `POST /estimate` — body `{ PipelineSpec, AuthContext }`. Returns `CostEstimate`. Called by 03/08 pre-run.
- Consumes `usage.recorded` (`UsageEvent`) from 04/05 → accrues spend.
- `GET /budgets/{ref}` / `PUT /budgets/{ref}` — `BudgetPolicy` CRUD.
- `POST /budgets/check` — `{ AuthContext, estimatedCredits }` → allow/deny.

## 4. Outbound contracts
- Emits `budget.threshold` (`BudgetPolicy`) when spend crosses a threshold → consumed by 03 (degrade), 05 (deprioritize/deny), 08 (warn/spend meter).
- Reads model `costWeight` from 06 and `GpuInventory`/lease pricing inputs from 05 (v1: 13).

## 5. Core data models (owned)
`CostEstimate`, `BudgetPolicy` (+ `BudgetRef`), `UsageEvent` (pricing of) — shared contracts §6.

## 6. Module dependencies
**Upstream:** 04/05 (usage), 06 (cost weights), 10 (`BudgetRef`/scope). **Downstream:** 03/05/08 (budget signals).

## 7. Functional requirements
- **FR-1** **Usage-based billing** reflecting GPU usage, processing duration, model complexity, storage, bandwidth. *(447–456)*
- **FR-2** **Pre-execution `CostEstimate`**: expected compute cost, GPU requirements, runtime estimate, credit consumption — from the `PipelineSpec` + model `costWeight` + GPU pricing. *(459–467)*
- **FR-3** **Budget constraints**: spend limits, daily/monthly caps, credit quotas, **emergency cutoffs**. *(470–478)*
- **FR-4** Dynamic pricing: price = f(gpuClass, gpu-seconds, model costWeight, storage, bandwidth); configurable rate card.
- **FR-5** Emit `budget.threshold` at warn/hard thresholds so the system degrades (03) or deprioritizes/halts (05) before overspend.
- **FR-6** Credit accounting per tenant/team/user scope, reconciled from `UsageEvent`s.

## 8. Non-functional requirements
- `POST /estimate` p95 ≤ 400 ms (inline in chat pre-run panel).
- Estimate within ±25% of actual for the canned demo scenarios (so the displayed number is credible).
- Usage accounting is exactly-once (no double-billing under retries) — keyed by `usageId`.

## 9. v1: mock vs real
**Real:** estimation math, pricing model, budget policy + enforcement, credit accounting, `budget.threshold`
emission. **Mocked inputs:** GPU-seconds and inventory/pricing context originate from module 13 (since no
real GPUs run); the cost *computation* over those inputs is genuine.

## 10. Open decisions
Rate-card source of truth; metering store; credit vs currency display; proration/refund on failed jobs; spot-price-aware dynamic pricing (roadmap).

## 11. Acceptance criteria
- `POST /estimate` on the "white cars" pipeline returns a credible credit/runtime estimate matching what the chat shows.
- A tenant near its cap triggers `budget.threshold`; 03 produces a cheaper pipeline and/or 05 deprioritizes.
- An `emergencyCutoff` budget hard-stops new runs for that scope.
