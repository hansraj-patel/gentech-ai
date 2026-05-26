# 00 — Shared Contracts

> The contract spine. Every module references the types defined here instead of re-defining its own.
> Tech-agnostic: schemas are expressed as JSON-shaped pseudo-types; the event bus is abstract (any
> broker — Kafka/NATS/SQS/Pub-Sub — may implement it). A field marked `?` is optional.
>
> **Golden rule:** a module may *own* a type (it is the authority that produces/mutates it) but every
> module *reads* the same definition from this file. If two modules disagree on a field, this file wins.

---

## 0. Conventions

- **IDs** are opaque strings, prefixed by type: `ten_`, `usr_`, `src_`, `seg_`, `job_`, `node_`, `lease_`, `evt_`, `trace_`. Treat as opaque; never parse.
- **Timestamps** are RFC-3339 UTC strings (`2026-05-26T18:00:00Z`).
- **Money** is integer **credits** (1 credit = smallest billable unit); never floats. Display conversion is a UI concern.
- **Enums** are lowercase snake-case strings.
- All cross-module calls carry an `AuthContext` (§2) and a `traceId` (§7).

---

## 1. Identity & Tenancy

```jsonc
// TenantId, UserId — opaque strings: "ten_a1b2", "usr_c3d4"

AuthContext {            // owned by module 10 (IAM); attached to EVERY request
  tenantId: TenantId,
  userId:   UserId,
  roles:    string[],            // e.g. ["analyst"], ["tenant_admin"]
  scopes:   string[],            // scoped-action grants, e.g. ["query:run","camera:read:src_*"]
  attrs:    { [k:string]: string }, // ABAC attributes: region, clearance, team, ...
  budgetRef?: BudgetRef          // active budget envelope this request bills against (§6)
}
```

---

## 2. Media

```jsonc
MediaSource {            // owned by module 01
  sourceId:  SourceId,
  tenantId:  TenantId,
  kind:      "rtsp" | "onvif" | "hls" | "upload",
  // live sources reference creds indirectly — NEVER inline:
  secretRef?: SecretRef,          // for rtsp/onvif/hls (module 02)
  connection?: {                  // non-secret connection metadata
    url?: string, host?: string, port?: number, onvifProfile?: string
  },
  upload?: {                      // for kind="upload"
    filename: string,
    bytesTotal?: number,          // may be unknown for streaming upload
    compression: CompressionPlan
  },
  health: "online" | "degraded" | "offline" | "unknown",
  createdAt: Timestamp
}

CompressionPlan {        // negotiated between desktop app (module 08) and orchestrator (module 03)
  decidedBy: "agent" | "user",
  targetResolution: string,       // "1280x720"
  targetBitrateKbps: number,
  targetFps: number,
  rationale?: string              // why the agent chose this (shown in UI / audit)
}

MediaSegment {           // owned by module 01 — the unit of progressive processing
  segmentId: SegmentId,
  sourceId:  SourceId,
  tenantId:  TenantId,
  index:     number,              // monotonic per source
  tStart:    number,              // seconds into stream/file
  tEnd:      number,
  storageRef: string,             // opaque pointer to bytes (blob URL/key); NOT the bytes
  codec:     string,
  final:     boolean              // last segment of a finite upload
}
```

---

## 3. Secrets

```jsonc
SecretRef {              // owned by module 02 — the ONLY thing other modules ever hold
  secretId: string,               // opaque handle; resolves to creds at runtime, tenant-scoped
  tenantId: TenantId
}

// Resolution result (module 02 -> caller). Short-lived, never persisted by callers.
EphemeralCredential {
  secretId: string,
  value:    string,               // decrypted credential material
  expiresAt: Timestamp,           // callers MUST discard after this
  leaseId:  string
}
```

---

## 4. Query, Pipeline & Jobs

```jsonc
Query {                  // owned by module 03; created by UI (module 08)
  queryId:   QueryId,
  tenantId:  TenantId,
  text:      string,              // natural-language objective
  sources:   SourceId[],          // which cameras/uploads to run against
  timeWindow?: { from: Timestamp, to: Timestamp },
  constraints?: {
    maxCredits?: number,
    maxLatencyMs?: number,
    minQuality?: "low" | "standard" | "high"
  }
}

PipelineSpec {           // owned by module 03 — a DAG; consumed by module 04
  pipelineId: PipelineId,
  queryId:    QueryId,
  tenantId:   TenantId,
  nodes:      PipelineNode[],
  edges:      { from: NodeId, to: NodeId }[],   // dependency edges; MUST be acyclic
  explanation?: string,           // NL "why this pipeline" (advanced enhancement; shown in UI)
  retryPolicy: RetryPolicy
}

PipelineNode {
  nodeId:   NodeId,
  task:     string,               // capability id, e.g. "object_detection","anpr","tracking"
  modelId:  ModelId,              // selected from module 06 registry
  params:   { [k:string]: any },  // task params, e.g. {classes:["car"], color:"white"}
  compute:  ComputeRequest,       // resource hint for this node (§6)
  parallelizable: boolean         // can fan out across segments/workers
}

JobId        // "job_..."  — a running instance of a PipelineSpec
JobStatus {  // owned by module 04
  jobId:     JobId,
  pipelineId: PipelineId,
  tenantId:  TenantId,
  state:     "queued" | "running" | "partial" | "succeeded" | "failed" | "cancelled" | "degraded",
  nodeStates: { [nodeId: string]: "pending"|"running"|"done"|"failed"|"skipped" },
  progress:  number,              // 0..1
  startedAt?: Timestamp,
  endedAt?:  Timestamp,
  costSoFar: number               // credits
}

RetryPolicy { maxRetries: number, backoff: "fixed"|"exponential", deadLetter: boolean }
```

---

## 5. Inference & Results

```jsonc
InferenceRequest {       // module 04 -> module 06 (real) / module 13 (mock). Same shape either way.
  requestId: string,
  jobId:     JobId,
  nodeId:    NodeId,
  modelId:   ModelId,
  segment:   { segmentId: SegmentId, storageRef: string },
  params:    { [k:string]: any }
}

InferenceResponse {      // module 06/13 -> module 04
  requestId: string,
  modelId:   ModelId,
  latencyMs: number,
  detections?: Detection[],
  tracks?:    Track[],
  embeddings?: number[][],
  ocr?:       { text: string, confidence: number, bbox: BBox }[],
  nsfwScore?: number,             // 0..1
  raw?:       { [k:string]: any }
}

Detection { label: string, confidence: number, bbox: BBox, attrs?: {[k:string]:string} } // attrs e.g. {color:"white"}
Track      { trackId: string, label: string, points: { t: number, bbox: BBox }[] }
BBox       { x: number, y: number, w: number, h: number }  // normalized 0..1

ResultEvent {            // owned by module 04 — the typed analytic output the UI renders
  resultId:  string,
  jobId:     JobId,
  tenantId:  TenantId,
  kind:      "count" | "timeseries" | "detections" | "tracks" | "match" | "heatmap" | "summary" | "table",
  partial:   boolean,             // true while job still running (progressive)
  payload:   any,                 // shape depends on `kind` (see module 08 for per-kind schemas)
  ts:        Timestamp
}
```

---

## 6. Compute, Resources & Cost

```jsonc
ComputeRequest {         // module 03/04 -> module 05
  gpuClass?: "none" | "small" | "medium" | "large", // "none" = CPU-only acceptable
  minVramGb?: number,
  estDurationSec?: number,
  priority:  number               // 0 (low) .. 9 (critical); set per governance (module 10)
}

WorkerLease {            // owned by module 05 — grant of compute
  leaseId:   string,
  jobId:     JobId,
  nodeId?:   NodeId,
  gpuClass:  string,
  vramGb:    number,
  cpuOnly:   boolean,
  grantedAt: Timestamp,
  expiresAt: Timestamp,
  endpoint?: string               // where to send work (mock or real worker)
}

GpuInventory {           // owned by module 05 (in v1: from mock server, module 13)
  total:     { [gpuClass:string]: number },
  available: { [gpuClass:string]: number },
  runningJobs: number,
  queueDepth: number,
  updatedAt: Timestamp
}

UsageEvent {             // emitted by 04/05 -> consumed by module 11
  usageId:   string,
  tenantId:  TenantId,
  jobId:     JobId,
  gpuSeconds: number,
  gpuClass:  string,
  storageGbHours?: number,
  bandwidthGb?: number,
  ts:        Timestamp
}

CostEstimate {           // owned by module 11 — computed BEFORE run from a PipelineSpec
  pipelineId: PipelineId,
  credits:    number,
  breakdown:  { item: string, credits: number }[],
  runtimeSecEst: number,
  gpuClassEst: string,
  confidence: "low" | "medium" | "high"
}

BudgetRef  // "bud_..."
BudgetPolicy {           // owned by module 11
  budgetRef:  BudgetRef,
  tenantId:   TenantId,
  scope:      "tenant" | "team" | "user",
  capCredits: number,
  period:     "daily" | "monthly" | "none",
  spent:      number,
  emergencyCutoff: boolean        // hard stop when exceeded
}
```

---

## 7. Event Envelope, Tracing & Errors

```jsonc
Event<T> {               // every message on the bus is wrapped in this
  eventId:  string,               // "evt_..."
  type:     string,               // canonical topic name (see §8)
  tenantId: TenantId,
  jobId?:   JobId,
  ts:       Timestamp,
  traceId:  string,               // "trace_..." — correlates all work for one user action
  payload:  T
}

TraceSpan {              // owned by module 12 — one step in a job's life
  traceId:  string,
  spanId:   string,
  parentSpanId?: string,
  module:   string,               // which module emitted it
  name:     string,               // "orchestrate","lease","infer","render",...
  startedAt: Timestamp,
  durationMs: number,
  attrs:    { [k:string]: any }
}

DecisionLog {            // owned by module 12 — agent/orchestrator decisions, for audit
  traceId:  string,
  actor:    "orchestrator" | "scheduler" | "render_agent" | "validator",
  decision: string,               // human-readable
  inputs:   any,
  output:   any,
  ts:       Timestamp
}

Error {                  // uniform error shape returned/emitted by every module
  code:     string,               // "VALIDATION_FAILED","BUDGET_EXCEEDED","LEASE_UNAVAILABLE",...
  module:   string,
  message:  string,
  retryable: boolean,
  details?: any
}
// Failures that exhaust RetryPolicy land on the dead-letter topic (§8) wrapped as Event<Error>.
```

---

## 8. Canonical Event Topics (abstract bus)

Producers/consumers agree on these names regardless of broker. `*` = tenant-partitioned.

| Topic | Producer | Consumers | Payload |
|---|---|---|---|
| `media.segment.created` | 01 | 04 | `MediaSegment` |
| `query.submitted` | 08 | 09 → 03 | `Query` |
| `pipeline.created` | 03 | 04, 11, 12 | `PipelineSpec` |
| `job.status.changed` | 04 | 08, 12 | `JobStatus` |
| `result.event` | 04 | 08, 12 | `ResultEvent` |
| `compute.lease.granted` | 05 | 04 | `WorkerLease` |
| `usage.recorded` | 04, 05 | 11 | `UsageEvent` |
| `budget.threshold` | 11 | 03, 05, 08 | `BudgetPolicy` |
| `alert.raised` | 07 | 08, 12 | `ResultEvent`(kind=summary/match) |
| `trace.span` / `decision.logged` | all / 03,05 | 12 | `TraceSpan` / `DecisionLog` |
| `dlq.failed` | all | 12, ops | `Event<Error>` |

---

## 9. UI Contracts (owned by module 08; produced by render agent)

```jsonc
RenderContext { role: string, device: "desktop"|"tablet"|"mobile", queryType: string }

UIComponentRegistry  // the WHITELIST the generative layout may draw from. Adding a component = editing this.
  entry {
    componentId: string,          // "counter","line_chart","bar_chart","timeline","heatmap",
                                  // "table","video_overlay","map","summary_card"
    propsSchema: JSONSchema,       // typed props the component accepts
    consumes:    ResultEvent["kind"][]  // which result kinds it can render
  }

UISpec {                 // the generative layout output: an ordered tree, NOT free-form HTML
  specId:   string,
  jobId:    JobId,
  context:  RenderContext,
  blocks:   UIBlock[]
}
UIBlock {
  componentId: string,            // MUST exist in UIComponentRegistry
  props:    { [k:string]: any },  // MUST validate against that component's propsSchema
  bindsTo?: string                // resultId this block renders
}
// Invariant: a UISpec is renderable iff every block.componentId is in the registry AND props validate.
// This is what keeps "truly generative" output spec-able and testable.
```

---

## 10. Ownership matrix (who is the authority for each type)

| Type | Owner module |
|---|---|
| `AuthContext`, ABAC attrs, `BudgetRef` resolution | 10 |
| `MediaSource`, `MediaSegment`, `CompressionPlan` | 01 |
| `SecretRef`, `EphemeralCredential` | 02 |
| `Query`, `PipelineSpec`, `PipelineNode`, `RetryPolicy` | 03 |
| `JobStatus`, `ResultEvent`, `InferenceRequest` | 04 |
| `WorkerLease`, `GpuInventory`, `ComputeRequest` | 05 |
| `InferenceResponse`, `ModelId` registry metadata | 06 (mocked outputs: 13) |
| `CostEstimate`, `BudgetPolicy`, `UsageEvent` pricing | 11 |
| `TraceSpan`, `DecisionLog`, `Error` taxonomy | 12 |
| `UISpec`, `UIComponentRegistry`, `RenderContext` | 08 |
