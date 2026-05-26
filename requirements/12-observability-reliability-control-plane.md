# 12 — Observability, Reliability & Control Plane

> Shared types: see [`00-shared-contracts.md`](./00-shared-contracts.md). Source lines: 407–443, 529–544.

## 1. Purpose
Two intertwined roles: (a) the **control plane** — the public API gateway and the event-bus topology that
binds every module; (b) **observability & reliability** — audit/decision logs, execution traces, model
invocation logs, health monitoring, circuit breakers, and the graceful-degradation policy that keeps the
system operating under stress.

## 2. In scope / Out of scope
**In:** public API gateway (auth handoff to 10, routing, rate limiting); event-bus topology + DLQ;
collection of `TraceSpan`/`DecisionLog`/model-invocation/failure logs; health checks; circuit breakers;
degradation policy orchestration.
**Out:** business logic of any module; the actual retries/checkpointing (04 implements; 12 observes); auth
decisions (10).

## 3. Inbound contracts
- Public API gateway: fronts all external HTTP/WS; validates session via 10, routes to modules.
- Consumes all observability topics: `trace.span`, `decision.logged`, `job.status.changed`, `dlq.failed`, model-invocation logs.
- `GET /health`, `GET /traces/{traceId}`, `GET /audit?...` (tenant-scoped).

## 4. Outbound contracts
- Hosts the abstract event bus (canonical topics, shared-contracts §8) — every module publishes/subscribes here.
- Exposes circuit-breaker state + health to 04/05 (they react by degrading).
- Surfaces traces/audit to 08 (DAG trace drawer, audit views).

## 5. Core data models (owned)
`TraceSpan`, `DecisionLog`, `Error` taxonomy — shared contracts §7. Plus:
```jsonc
HealthStatus { module:string, state:"healthy"|"degraded"|"down", lastCheck:Timestamp, details?:any }
CircuitBreaker { target:string, state:"closed"|"open"|"half_open", failureRate:number, since:Timestamp }
DegradationPolicy { trigger:"budget"|"load"|"failure", actions:("lower_fps"|"lower_res"|"lightweight_model"|"defer_noncritical")[] }
```

## 6. Module dependencies
**Upstream:** every module (emits telemetry; routes through the gateway). **Downstream:** 08 (traces/audit), 04/05 (breaker/health signals).

## 7. Functional requirements
- **FR-1** Maintain **agent decision logs, pipeline execution traces, model invocation logs, failure logs, retry histories** — all correlated by `traceId`, tenant-scoped (logging isolation). *(407–417)*
- **FR-2** **Health monitoring** + **circuit breakers**: open a breaker on a failing dependency; surface state so 04/05 degrade. *(440–443)*
- **FR-3** **Graceful degradation policy**: under constrained conditions drive lower FPS / reduced resolution / lightweight models / deferred non-critical analytics. *(419–428)*
- **FR-4** Reliability support: observe retries, dead-letter (`dlq.failed`), checkpointing, partial recovery emitted by 04; expose retry histories. *(432–443)*
- **FR-5** **Control plane**: public API gateway (routing, rate-limit, session handoff to 10) and the canonical event bus topology. *(529–544)*
- **FR-6** Tenant-scoped audit/observability reads (no cross-tenant log leakage). *(396)*

## 8. Non-functional requirements
- Tracing overhead ≤ 5% of request latency; sampling configurable.
- Gateway adds ≤ 20 ms p95 routing overhead.
- Logs are append-only and tamper-evident for audit/compliance.
- Cloud-agnostic: bus + log/trace sinks behind adapters (no single-cloud lock-in). *(515–527)*

## 9. v1: mock vs real
**Real** — gateway, event bus, trace/decision/audit collection, health, circuit breakers, and degradation
orchestration are real (they're how the demo shows live DAG progress, traces, and graceful behavior). The
*events being observed* originate from real modules running against mock data.

## 10. Open decisions
Bus impl (Kafka/NATS/Pub-Sub/SQS behind adapter); tracing stack (OpenTelemetry); log store; gateway tech; sampling strategy.

## 11. Acceptance criteria
- A single user action produces one `traceId` spanning 03→04→05/06 spans, viewable in the screen-5 trace drawer.
- Forcing repeated node failures opens a circuit breaker; the engine degrades (lighter model / deferred node) instead of hard-failing.
- Audit query for tenant A never returns tenant B entries.
