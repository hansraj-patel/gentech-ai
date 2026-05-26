# GenTech AI — Agentic Layer (v1)

The **real intelligence** core of the platform: a natural-language video-analytics query
becomes a real, validated, costed processing pipeline. Per the v1 boundary
(`requirements/00-system-overview.md`), *intelligence is real; GPUs/CV/pixels are faked* —
this build implements the real part.

What's built here (TypeScript / pnpm workspace):

| Package | Module | Role |
|---|---|---|
| `@gentech/contracts` | shared | zod schemas + inferred types + validators (the contract spine) |
| `@gentech/model-registry` | 06 | real `ModelMetadata` catalog + deterministic `findModels()` |
| `@gentech/cost` | 11 | real `estimate()` (critical-path + rate card) + `checkBudget()` |
| `@gentech/orchestrator` | 03 | NL `Query` → `PipelineSpec` (+ `CostEstimate`) |

Stubbed for now (replaced by real modules later, no contract changes): 09 query validation,
10 IAM/`AuthContext`, 12 event bus, 04 execution. The OpenUI generative-UI surface (module 08)
is the eventual render target and consumes the `UISpec` contract — not built here.

## How the orchestrator works (hybrid)

1. **Plan (LLM, real):** Claude with forced tool-use emits a *capability-level* DAG from a fixed
   ontology (`ontology.ts`) — tasks + params + topology, **no model picks**. `temperature:0`.
   A repair loop feeds validation errors back; a deterministic rules planner is the fail-safe.
2. **Resolve (deterministic):** each capability node → a concrete `modelId` from the registry,
   honoring `Query.constraints`; attaches `ComputeRequest` hints, wires edges, validates the DAG
   (acyclic + every model resolvable).
3. **Estimate + degrade:** real cost math; if over `maxCredits`/budget, re-resolve cheaper (FR-8),
   or fail with `BUDGET_EXCEEDED`.

This split keeps model selection reproducible, auditable, and unit-testable independent of the LLM.

## Run it

```bash
pnpm install
pnpm build
pnpm test                         # 24 unit/golden tests (LLM mocked, offline)

# demo CLI (uses Claude if ANTHROPIC_API_KEY is set, else the deterministic rules planner)
pnpm orchestrate "how many white cars?"
pnpm orchestrate "find the car with number plate ABC1234"
pnpm orchestrate "how many white cars?" --min-quality high --max-credits 50   # shows degradation
```

The real-Claude integration test runs only when `ANTHROPIC_API_KEY` is present (`pnpm test` skips it otherwise).
