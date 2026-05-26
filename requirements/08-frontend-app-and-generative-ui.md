# 08 — Frontend App & Generative UI

> Shared types: see [`00-shared-contracts.md`](./00-shared-contracts.md) (§9 UI contracts). Source lines: 23–35, 39–96, 328–349.
> **Format:** per-screen spec tables + ASCII wireframes. **Tech:** framework-agnostic. **Structure:** ONE role-gated web app.

## 1. Purpose
The entire v1 user-facing product: a single role-gated web app whose **primary surface is a generative-UI
chat**. Users connect sources, upload video, type analytical objectives, and receive results rendered as
**generative UI blocks composed inline in a conversation** from a bounded, typed component registry. Plus
a thin desktop uploader for client-side compression.

## 2. In scope / Out of scope
**In:** 7 v1 screens + app shell; the generative-UI chat surface; the `UIComponentRegistry` + `UISpec`
rendering; the thin desktop app spec.
**Out:** producing `UISpec`s (the render agent does, conceptually part of 03/04's output path — 08 owns the
*registry + renderer*, not the layout decision); admin/governance/operator screens (v2); any analysis logic.

## 3. Inbound contracts (data the UI consumes, by source module)
| UI need | From | Contract |
|---|---|---|
| Auth, role, scopes | 10 | `AuthContext` |
| Source list / health | 01 | `MediaSource` |
| Upload sessions | 01 | upload session API |
| Cost estimate + capability/safety hints (pre-run) | 11 + 09 | `CostEstimate`, validation result |
| Pipeline DAG | 03 / 04 | `PipelineSpec`, `JobStatus` |
| Results (rendered) | 04 | `result.event` (`ResultEvent`) → `UISpec` |
| Alerts | 07 | `alert.raised` |
| Spend meter | 11 | `BudgetPolicy` |

## 4. Outbound contracts (what the UI emits)
- `POST /sources` (connect camera), upload chunks → 01. Camera creds go to 02 as a `SecretRef` (never stored client-side).
- `query.submitted` (`Query`) → 09 → 03.
- Run/cancel job → 04. Deploy preset/monitor → 07.

## 5. Core data models (owned)
`UISpec`, `UIComponentRegistry`, `RenderContext`, `UIBlock` — shared contracts §9.

## 6. Module dependencies
**Upstream:** all data-producing modules above + 12 (API gateway it calls through). **Downstream:** none (it's the edge).

---

## 7. App shell (shared chrome on every screen)

```
┌───────────────────────────────────────────────────────────────────────────┐
│ [≡] GenTech AI            🔍 global search           🔔  💰 1,240 cr  ▼ten ▲ │  ← top bar: tenant+role badge, spend meter, notifications
├──────────┬────────────────────────────────────────────────────────────────┤
│ ⌂ Home   │                                                                  │
│ 📷 Sources│                     <active screen renders here>                 │
│ ⬆ Uploads │                                                                  │
│ 💬 Chat   │                                                                  │
│ ▦ Presets │                                                                  │
│ 🔔 Alerts │                                                                  │
│──────────│                                                                  │
│ (admin*)  │   * admin/operator nav items shown only if role permits         │
└──────────┴────────────────────────────────────────────────────────────────┘
```
Nav items render/hide by `AuthContext.roles`. Spend meter binds to `BudgetPolicy`.

---

## 7.1 Screen 1 — Login & Tenant Switcher
| Aspect | Detail |
|---|---|
| Purpose | Authenticate; pick active tenant. |
| Sections | SSO panel · email/password fallback · post-auth tenant picker. |
| Elements | SSO button(s), email+password fields, "Continue", tenant dropdown. |
| States | unauthenticated · authenticating · multi-tenant-select · error. |
| Data | 10 (`AuthContext`). |
```
┌──────────── GenTech AI ────────────┐
│   [ Sign in with SSO ]             │
│   ── or ──                         │
│   email    [______________]        │
│   password [______________]        │
│            [   Continue   ]        │
│   ▸ tenant: ( Acme Vision  ▼ )     │
└────────────────────────────────────┘
```

## 7.2 Screen 2 — Sources & Connect Camera
| Aspect | Detail |
|---|---|
| Purpose | List sources + health; connect a new camera. |
| Sections | source list (cards) · Connect-Camera form (right drawer) · test-connection. |
| Elements | card{name, type badge, health dot, last-seen}; form: kind selector → **conditional fields** (RTSP url / ONVIF host+port+profile / HLS url) + credential fields; "Test", "Save". |
| States | empty · listing · form-open · testing · test-ok/test-fail. |
| Data in | 01 `MediaSource`. Data out | `POST /sources`; creds → 02 as `SecretRef`. |
```
┌ Sources ─────────────────────────┬ Connect Camera ───────────┐
│ ● Lobby-RTSP   rtsp   online      │ kind: (RTSP ▼)            │
│ ◐ Gate-ONVIF   onvif  degraded    │ rtsp url [_____________]  │
│ ○ Lot-HLS      hls    offline     │ user [____] pass [____]   │  ← creds tokenized → vault
│ [ + Connect camera ]              │ [ Test ]      [ Save ]    │
└───────────────────────────────────┴───────────────────────────┘
```

## 7.3 Screen 3 — Uploads
| Aspect | Detail |
|---|---|
| Purpose | Upload video; show compression negotiation + progress. |
| Sections | dropzone · per-file rows · upload settings. |
| Elements | resumable dropzone; row{thumb, filename, progress bar, compression-target chip, status}; toggle "let agent decide quality / force quality". |
| States | idle · uploading · paused/resumable · compressing · done · error. |
| Data | 01 (sessions/chunks); compression chip ← 03 `CompressionPlan`. |
```
┌ Uploads ──────────────────────────────────────────────┐
│  ⬆ Drag files here or [browse]                         │
│  ▸ gate_4k.mp4   [▓▓▓▓▓▓░░░] 64%  →720p@2Mbps (agent)  │
│  ▸ lot_cam.mov   [▓▓▓▓▓▓▓▓▓] done                      │
│  settings: (•) let agent decide  ( ) force high quality│
└────────────────────────────────────────────────────────┘
```

## 7.4 Screen 4 — Generative-UI Chat  ★ primary surface
| Aspect | Detail |
|---|---|
| Purpose | Type NL objective → see real cost → run → results render inline as generative UI blocks. |
| Sections | conversation thread · composer · per-turn pre-run panel · per-turn generative result area · "view DAG" affordance. |
| Elements | message bubbles; composer{textarea, source/time-range selector, preset chips, Send}; pre-run panel{cost estimate, runtime est, capability+safety hints, **Run** (disabled if budget/safety blocks)}; result area = rendered `UISpec` blocks; "⤢ view pipeline" → screen 5. |
| States | composing · validating(09) · estimate-ready · running(progressive `partial` blocks stream in) · complete · blocked(safety/budget) · error. |
| Data in | 11 `CostEstimate`, 09 validation, 04 `ResultEvent`→`UISpec`. Data out | `Query`. |
```
┌ Chat ───────────────────────────────────────────────────────────┐
│ 🧑 "How many white cars at Lot-HLS between 2–4pm?"               │
│ 🤖 Plan: detect→classify→color→count.  est 18 cr · ~40s · GPU:sm │
│     safety ✓  capability ✓        [ Run ]   ⤢ view pipeline      │
│ 🤖 ┌ counter ─┐ ┌ timeline ──────┐ ┌ summary ───────────────┐   │  ← generative UISpec blocks
│    │   37     │ │  ▁▂▅▇▅▂▁        │ │ "37 white cars; peak…" │   │
│    └──────────┘ └────────────────┘ └────────────────────────┘   │
│ [ type an objective…                                  ] [Send]  │
└──────────────────────────────────────────────────────────────────┘
```

## 7.5 Screen 5 — Job / Run Detail (DAG)
| Aspect | Detail |
|---|---|
| Purpose | Inspect a run: pipeline graph, live stage status, traces, cost. |
| Sections | progress header · DAG canvas · node detail/trace drawer · partial-results strip. |
| Elements | header{stage x/y, elapsed, cost-so-far}; DAG nodes color-coded by state (pending/running/done/failed/skipped); click node → trace drawer; cancel. |
| States | queued · running · partial · succeeded · failed · degraded · cancelled. |
| Data | 03 `PipelineSpec`, 04 `JobStatus`, 12 `TraceSpan`. |
```
┌ Run job_8f2 ──────────────────── stage 3/4 · 22s · 11 cr ──────┐
│  [detect]──▶[classify]──▶[color]──▶[count]                     │
│    ✔done      ✔done       ●running   ○pending                  │
│  ▸ node "color": model=yolo-cls-v3  lat 31ms  ▸ trace…         │
└─────────────────────────────────────────────────────────────────┘
```

## 7.6 Screen 6 — Presets
| Aspect | Detail |
|---|---|
| Purpose | Browse preset catalog; configure & deploy as a monitor. |
| Sections | catalog grid · configure drawer. |
| Elements | preset cards (intrusion/count/queue/anpr/crowd); drawer{params form (from `paramsSchema`), source binding, schedule(continuous/windowed), Deploy}. |
| States | browsing · configuring · deploying · deployed. |
| Data | 07 `PresetDefinition`; out → `POST /monitors`. |
```
┌ Presets ───────────────────────────┬ Configure: Vehicle Count ─┐
│ [Intrusion] [Vehicle Count]         │ sources ☑ Lot-HLS         │
│ [Queue Mon] [ANPR Scan] [Crowd]     │ window  (60s ▼)           │
│                                     │ schedule (continuous ▼)   │
│                                     │        [ Deploy monitor ] │
└─────────────────────────────────────┴───────────────────────────┘
```

## 7.7 Screen 7 — Alerts / Events
| Aspect | Detail |
|---|---|
| Purpose | Triage event-driven alerts from monitors. |
| Sections | filter bar · alert feed · detail → jump to clip/result. |
| Elements | feed row{severity, source, snapshot thumb, metric, time}; filters{source, severity, time}; row click → opens originating result/clip. |
| States | empty · streaming · filtered · detail-open. |
| Data | 07 `alert.raised` (`ResultEvent`). |
```
┌ Alerts ───────────────────────────────────────────────┐
│ filter: [source ▼][severity ▼][today ▼]                │
│ 🔴 Gate-ONVIF  intrusion detected      18:02  [view]   │
│ 🟠 Lot-HLS     queue > 12 vehicles      17:48  [view]   │
└─────────────────────────────────────────────────────────┘
```

---

## 8. Generative-UI component registry (the whitelist)

The render agent composes a `UISpec` **only** from these. Adding a component = adding an entry here +
its `propsSchema`. A `UISpec` is renderable iff every block's `componentId` is registered and its props
validate (invariant from shared-contracts §9).

| componentId | renders `ResultEvent.kind` | key props |
|---|---|---|
| `counter` | count | `{label, value, deltaPct?}` |
| `line_chart` / `bar_chart` | timeseries | `{series:[{t,value}], xLabel, yLabel}` |
| `timeline` | detections/tracks | `{events:[{t, label}]}` |
| `heatmap` | heatmap | `{grid:number[][], legend}` |
| `table` | table | `{columns, rows}` |
| `video_overlay` | detections/tracks | `{clipRef, boxes:[{t, bbox, label}]}` |
| `map` | match/detections | `{points:[{lat,lng,label}]}` |
| `summary_card` | summary | `{title, markdown}` |

**Adaptivity** (`RenderContext`): the agent picks/arranges blocks by query type (count→counter+timeline),
user role (analyst sees overlays; viewer sees summary only), and device (mobile → stacked, fewer blocks).

## 9. Thin desktop app (compression uploader)
| Aspect | Detail |
|---|---|
| Purpose | Pick local source/file → negotiate compression target with the agent → resumable upload. **No analytics UI.** |
| Flow | select file/device → `POST /compression-plan` (03) → transcode locally to target res/bitrate/fps → resumable chunk upload (01). |
| Elements | source picker, target chip (read-only, from agent), progress bar, pause/resume. |
| States | idle · negotiating · transcoding · uploading · paused · done · error. |

## 10. Non-functional requirements
- Generative-UI render of a `UISpec` ≤ 100 ms after receipt; progressive blocks update without full re-render.
- Role-gating is enforced server-side too (UI hiding is not security).
- Responsive across desktop/tablet/mobile per `RenderContext.device`.
- Accessibility: keyboard-navigable chat + DAG; charts have text/table fallbacks.

## 11. v1: mock vs real
**Fully real** — the entire app, chat surface, registry, and renderer are real. It renders **real**
`UISpec`s built from results that (under the hood) came from the mock server; the UI is agnostic to that.

## 12. Open decisions
Framework (React/Next/Svelte/etc.); charting lib; DAG-viz lib; whether the render agent runs server-side (emits `UISpec`) or client-side (recommended: server-side, so `UISpec` is a contract artifact).

## 13. Acceptance criteria
- The 7 screens render with role-gated nav; an analyst and a viewer see different nav + result blocks for the same job.
- Typing the "white cars" query shows a real cost estimate, then on Run streams `partial` blocks that finalize.
- A `UISpec` referencing an unregistered component or invalid props is rejected by the renderer (invariant holds).
- Desktop app negotiates a compression target and resumably uploads the downscaled file.
