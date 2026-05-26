/**
 * Orchestration host (WP-E) — the integration seam that turns a natural-language
 * query into live UI by driving the REAL modules end-to-end on one shared bus:
 *
 *   resolveAuth (10) → buildQuery + query.submitted
 *     → validateQuery (09) gate  ── DENIED → notice UISpec, engine never runs
 *     → orchestrate (03, injected real 09/10 + budget 11) → pipeline.created
 *     → PipelineEngine.run (04) against MockBackend + mockSegments (13)
 *        streaming job.status.changed / result.event / usage.recorded / trace.span
 *     → render-agent.render (08) of the collected results → a `ui.spec` event.
 *
 * Everything is published on the `InProcessEventBus` (the engine's `EventSink`),
 * so the recorder and the gateway's SSE stream observe the same live events.
 */
import {
  makeId,
  type AuthContext,
  type Event,
  type JobStatus,
  type RenderContext,
  type ResultEvent,
  type UISpec,
} from "@gentech/contracts";
import { CATALOG } from "@gentech/model-registry";
import { buildQuery, orchestrate, RuleBasedPlanner } from "@gentech/orchestrator";
import { resolveAuth, priorityFor as iamPriorityFor } from "@gentech/iam";
import { validateQuery as safetyValidateQuery } from "@gentech/safety";
import { MockBackend, getScenario, mockSegments } from "@gentech/mock-server";
import { PipelineEngine } from "@gentech/engine";
import { render } from "@gentech/render-agent";
import { InProcessEventBus } from "./bus.js";
import { Recorder } from "./recorder.js";

/** The topic the render-agent's `UISpec` is published on (gateway-streamed). */
export const UI_SPEC_TOPIC = "ui.spec";

export interface HostOptions {
  /** Share an existing bus (e.g. one the gateway/recorder already watches). */
  bus?: InProcessEventBus;
  /** Share an existing recorder; otherwise the host builds one over the bus. */
  recorder?: Recorder;
  /** Default tenant when an input carries no `auth`. */
  tenantId?: string;
  /** Default mock scenario when an input carries no `scenario`. */
  scenario?: string;
  /** Inference latency seed forwarded to the mock backend. */
  seed?: string;
}

export interface SubmitInput {
  text: string;
  sources?: string[];
  auth?: AuthContext;
  scenario?: string;
}

export interface SubmitOutput {
  jobId: string;
  traceId: string;
  /** Engine job state, or `blocked` when the safety gate denied the query. */
  status: JobStatus["state"] | "blocked";
  /** False when the safety gate short-circuited before the engine ran. */
  ran: boolean;
  /** The final spec id emitted on `ui.spec` (always present). */
  specId: string;
}

export interface Host {
  bus: InProcessEventBus;
  recorder: Recorder;
  submit(input: SubmitInput): Promise<SubmitOutput>;
}

/**
 * Build the orchestration host. Wires the real 09/10/11/03/04/13/08 path onto a
 * single in-process bus; reuse an existing `bus`/`recorder` to share telemetry.
 */
export function createHost(opts: HostOptions = {}): Host {
  const bus = opts.bus ?? new InProcessEventBus();
  const recorder = opts.recorder ?? new Recorder(bus);
  const defaultTenant = opts.tenantId ?? "ten_demo";
  const defaultScenario = opts.scenario ?? "parking_lot_daytime";
  const seed = opts.seed ?? "demo";

  // Pre-compute the model latency lookup once (matches the engine CLI).
  const latency = new Map(CATALOG.map((m) => [m.modelId, m.latencyMsEst]));

  const submit = async (input: SubmitInput): Promise<SubmitOutput> => {
    const auth = input.auth ?? resolveAuth({ tenantId: defaultTenant });
    const tenantId = auth.tenantId;
    const role = auth.roles[0] ?? "analyst";
    const scenarioId = input.scenario ?? defaultScenario;
    const scenario = getScenario(scenarioId);
    const sources = input.sources ?? [scenario.sources[0]!.sourceId];

    const query = buildQuery({ text: input.text, sources, tenantId });
    const traceId = makeId("PipelineId").replace("pipe_", "trace_");
    const renderCtx: RenderContext = { tenantId, role, query: input.text };

    const emit = (type: string, payload: unknown, jobId?: string): void =>
      bus.emit(type, envelope(type, tenantId, traceId, payload, jobId));

    emit("query.submitted", query);

    // ── module 09 gate ────────────────────────────────────────────────────────
    const verdict = safetyValidateQuery(query, auth);
    if (!verdict.allow) {
      const jobId = makeId("JobId");
      const blocked: JobStatus = {
        jobId,
        pipelineId: makeId("PipelineId"),
        tenantId,
        state: "failed",
        nodeStates: {},
        progress: 0,
        costSoFar: 0,
      };
      emit("job.status.changed", blocked, jobId);
      const notice: ResultEvent = {
        resultId: makeId("ResultId"),
        jobId,
        tenantId,
        kind: "summary",
        partial: false,
        payload: {
          title: "Query blocked",
          body: `This query was denied by policy: ${verdict.reasons
            .map((r) => r.message)
            .join("; ")}`,
          reasons: verdict.reasons,
        },
        ts: new Date().toISOString(),
      };
      emit("result.event", notice, jobId);
      // Render the denial reasons into a notice UISpec (a summary_card block).
      const spec = render([notice], renderCtx, {
        queryId: query.queryId,
        jobId,
        explanation: "Query blocked by safety policy.",
      });
      emit(UI_SPEC_TOPIC, spec, jobId);
      return { jobId, traceId, status: "blocked", ran: false, specId: spec.specId };
    }

    // ── module 03: plan + cost + degrade (real 09/10 injected, budget 11 inside) ─
    // NB: orchestrate's `bus` is the module-03 stub bus (publish/published), not
    // this control-plane bus; omit it and re-emit `pipeline.created` ourselves.
    const { pipeline } = await orchestrate(query, {
      planner: new RuleBasedPlanner(),
      auth,
      traceId,
      validateQuery: safetyValidateQuery,
      priorityFor: iamPriorityFor,
    });
    emit("pipeline.created", pipeline);

    // ── module 04/13: execute the DAG against the mock backend on the shared bus ─
    const backend = new MockBackend({
      scenarioId,
      seed,
      latencyLookup: (id) => latency.get(id),
    });
    const segments = mockSegments(scenario, tenantId);
    const engine = new PipelineEngine();
    const { job, results } = await engine.run(
      pipeline,
      segments,
      auth,
      { inference: backend, compute: backend, sink: bus },
      { traceId },
    );

    // ── module 08: render the collected results into a final UISpec ─────────────
    const finalResults = results.filter((r) => !r.partial);
    const spec = render(finalResults.length > 0 ? finalResults : results, renderCtx, {
      queryId: query.queryId,
      jobId: job.jobId,
    });
    emit(UI_SPEC_TOPIC, spec, job.jobId);

    return { jobId: job.jobId, traceId, status: job.state, ran: true, specId: spec.specId };
  };

  return { bus, recorder, submit };
}

// ── gateway adapter ─────────────────────────────────────────────────────────────
import { Gateway, type SubmitFn } from "./gateway.js";

export interface GatewayHost extends Host {
  gateway: Gateway;
}

/**
 * Build a `Gateway` fronting a freshly-wired host. The gateway's `SubmitFn`
 * takes `(query, auth)`; we adapt it to the host's richer `SubmitInput` and
 * return only the `{ jobId, traceId }` the transport contract expects.
 */
export function createGatewayHost(opts: HostOptions = {}): GatewayHost {
  const host = createHost(opts);
  const submitFn: SubmitFn = async (query, auth) => {
    const { jobId, traceId } = await host.submit({
      text: query.text,
      sources: query.sources,
      auth,
    });
    return { jobId, traceId };
  };
  const gateway = new Gateway({ bus: host.bus, recorder: host.recorder, submit: submitFn });
  return { ...host, gateway };
}

// ── helpers ──────────────────────────────────────────────────────────────────────

/** Build a §7 event envelope (mirrors the engine's internal `event()`). */
function envelope(
  type: string,
  tenantId: string,
  traceId: string,
  payload: unknown,
  jobId?: string,
): Event {
  return {
    eventId: makeId("EventId"),
    type,
    tenantId,
    ...(jobId ? { jobId } : {}),
    ts: new Date().toISOString(),
    traceId,
    payload,
  };
}
