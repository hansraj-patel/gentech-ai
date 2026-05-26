# 07 — Preset Pipelines & Continuous Stream Processing

> Shared types: see [`00-shared-contracts.md`](./00-shared-contracts.md). Source lines: 272–326, 301–309.

## 1. Purpose
Provide ready-made analytics workflows and the machinery for **long-running, always-on** processing of
live streams: persistent ingestion pipelines, event-driven alerting, and time-window analytics. Presets
turn into the same `PipelineSpec` the orchestrator emits, so execution reuses module 04 unchanged.

## 2. In scope / Out of scope
**In:** preset catalog + parameterization; binding a preset to source(s) + schedule; deploying presets as
continuous monitors; long-running job lifecycle; event-driven alerts; tumbling/sliding time-window
aggregation.
**Out:** building ad-hoc NL pipelines (03 — presets may *reuse* 03 to materialize a spec); executing nodes
(04); rendering alerts (08).

## 3. Inbound contracts
- `GET /presets` — catalog of `PresetDefinition`s.
- `POST /monitors` — body `{ presetId, params, sources, schedule, AuthContext }`. Deploys a continuous monitor; returns a long-running `JobId`.
- `GET /monitors/{id}` / `DELETE /monitors/{id}` — status / stop.

## 4. Outbound contracts
- Materializes a preset into a `PipelineSpec` (directly or via 03) → emits `pipeline.created`.
- Emits `alert.raised` (`ResultEvent` kind `summary`/`match`) on triggers.
- Consumes `result.event` / `media.segment.created` to drive windowed analytics; emits `usage.recorded`.

## 5. Core data models (owned)
```jsonc
PresetDefinition {
  presetId: string, name: string,
  category: "intrusion"|"vehicle_count"|"queue_monitor"|"anpr_scan"|"crowd_analytics",
  paramsSchema: JSONSchema,
  pipelineTemplate: PipelineSpec   // parameterized template
}
Monitor { monitorId: string, jobId: JobId, presetId: string, sources: SourceId[],
          schedule: { mode:"continuous"|"windowed", windowSec?: number }, state: JobStatus["state"] }
AlertRule { metric: string, op: ">"|"<"|"=="|"!=", threshold: number, windowSec?: number }
```

## 6. Module dependencies
**Upstream:** 03 (optional spec materialization), 01 (segments), 10 (`AuthContext`). **Downstream:** 04 (execution), 08 (alerts), 11 (usage), 12 (traces).

## 7. Functional requirements
- **FR-1** Ship presets for intrusion detection, vehicle counting, queue monitoring, license-plate scanning, crowd analytics. *(278–285)*
- **FR-2** Users can also deploy arbitrary NL objectives as continuous monitors (delegates to 03). *(288–299)*
- **FR-3** **Continuous stream processing**: persistent ingestion pipelines, long-running jobs, event-driven alerting, time-window analytics. *(301–309)*
- **FR-4** Time-window analytics: tumbling/sliding windows produce periodic `ResultEvent`s (counts, rates).
- **FR-5** `AlertRule`s fire `alert.raised` when a windowed metric crosses a threshold (e.g. intrusion, queue length).
- **FR-6** Smart prioritization hints flow to 05 (time-of-day/hotspot priority on monitors). *(312–325)*

## 8. Non-functional requirements
- Monitors survive restarts (checkpointed via 04); no missed windows on recovery.
- Alert end-to-end latency (event → `alert.raised`) ≤ 5 s for live streams.

## 9. v1: mock vs real
**Real:** preset catalog, monitor lifecycle, window aggregation logic, alert-rule evaluation. **Mocked:**
the underlying `ResultEvent`s come from 04 running against module 13; module 13's time simulation drives
alerts firing on a simulated clock so the Alerts screen is live.

## 10. Open decisions
Window engine (stream processor vs in-engine); schedule/cron model; alert dedup/suppression; preset versioning.

## 11. Acceptance criteria
- Deploying the "vehicle_count" preset on a source produces periodic windowed counts.
- An `AlertRule` threshold crossing emits exactly one `alert.raised` (with suppression) visible on screen 7.
- Stopping a monitor tears down its long-running job.
