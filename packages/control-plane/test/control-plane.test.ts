import { describe, it, expect } from "vitest";
import type {
  AuthContext,
  Event,
  JobStatus,
  ResultEvent,
} from "@gentech/contracts";
import { TOPICS } from "@gentech/contracts";
import {
  InProcessEventBus,
  Recorder,
  HealthRegistry,
  Gateway,
  type SubmitFn,
} from "../dist/index.js";

// ── tiny event-envelope builders ─────────────────────────────────────────────
let seq = 0;
const ts = () => new Date().toISOString();

function envelope<T>(
  type: string,
  tenantId: string,
  traceId: string,
  payload: T,
  jobId?: string,
): Event<T> {
  return { eventId: `evt_${seq++}`, type, tenantId, traceId, jobId, ts: ts(), payload };
}

function resultEvent(tenantId: string, jobId: string, kind: ResultEvent["kind"] = "count"): ResultEvent {
  return { resultId: `res_${seq++}`, jobId, tenantId, kind, partial: false, payload: {}, ts: ts() };
}

function jobStatus(tenantId: string, jobId: string, state: JobStatus["state"] = "running"): JobStatus {
  return {
    jobId,
    pipelineId: "pipe_1",
    tenantId,
    state,
    nodeStates: {},
    progress: 0.5,
    costSoFar: 0,
  };
}

// ── bus ───────────────────────────────────────────────────────────────────────
describe("InProcessEventBus", () => {
  it("fans out to topic subscribers and wildcard, supports unsubscribe + replay", () => {
    const bus = new InProcessEventBus();
    const onResult: Event[] = [];
    const onAll: Event[] = [];

    const offResult = bus.subscribe(TOPICS.resultEvent, (e) => onResult.push(e));
    bus.subscribe("*", (e) => onAll.push(e));

    const e1 = envelope(TOPICS.resultEvent, "t1", "tr1", resultEvent("t1", "j1"));
    bus.emit(TOPICS.resultEvent, e1);
    expect(onResult).toHaveLength(1);
    expect(onAll).toHaveLength(1);

    offResult();
    const e2 = envelope(TOPICS.resultEvent, "t1", "tr1", resultEvent("t1", "j1"));
    bus.emit(TOPICS.resultEvent, e2);
    expect(onResult).toHaveLength(1); // unsubscribed
    expect(onAll).toHaveLength(2); // wildcard still active

    // replay buffers everything; filter narrows by tenant/trace
    expect(bus.replay()).toHaveLength(2);
    expect(bus.replay({ tenantId: "t1", traceId: "tr1" })).toHaveLength(2);
    expect(bus.replay({ tenantId: "other" })).toHaveLength(0);
  });

  it("isolates a throwing handler from the rest of the fan-out", () => {
    const bus = new InProcessEventBus();
    const seen: Event[] = [];
    bus.subscribe("*", () => {
      throw new Error("boom");
    });
    bus.subscribe("*", (e) => seen.push(e));
    bus.emit(TOPICS.jobStatusChanged, envelope(TOPICS.jobStatusChanged, "t1", "tr1", {}));
    expect(seen).toHaveLength(1);
  });
});

// ── recorder tenant isolation ───────────────────────────────────────────────
describe("Recorder", () => {
  it("indexes by trace + tenant and never leaks across tenants", () => {
    const bus = new InProcessEventBus();
    const rec = new Recorder(bus);

    // tenant A has a job/trace
    bus.emit(TOPICS.resultEvent, envelope(TOPICS.resultEvent, "A", "trA", resultEvent("A", "jobX"), "jobX"));
    bus.emit(TOPICS.jobStatusChanged, envelope(TOPICS.jobStatusChanged, "A", "trA", jobStatus("A", "jobX"), "jobX"));
    bus.emit(
      TOPICS.traceSpan,
      envelope(TOPICS.traceSpan, "A", "trA", {
        traceId: "trA",
        spanId: "s1",
        module: "engine",
        name: "run",
        startedAt: ts(),
        durationMs: 1,
        attrs: {},
      }),
    );
    bus.emit(
      TOPICS.decisionLogged,
      envelope(TOPICS.decisionLogged, "A", "trA", {
        traceId: "trA",
        actor: "iam",
        decision: "allow",
        inputs: {},
        output: {},
        ts: ts(),
      }),
    );

    // tenant A reads its own data
    expect(rec.resultsFor("A", "jobX")).toHaveLength(1);
    expect(rec.jobStatus("A", "jobX")?.state).toBe("running");
    expect(rec.spansFor("A", "trA")).toHaveLength(1);
    expect(rec.decisionsFor("A", "trA")).toHaveLength(1);

    // tenant B, using the SAME ids, sees nothing
    expect(rec.resultsFor("B", "jobX")).toHaveLength(0);
    expect(rec.jobStatus("B", "jobX")).toBeUndefined();
    expect(rec.spansFor("B", "trA")).toHaveLength(0);
    expect(rec.decisionsFor("B", "trA")).toHaveLength(0);

    rec.close();
  });
});

// ── health / circuit breaker ─────────────────────────────────────────────────
describe("HealthRegistry", () => {
  it("tracks per-module health", () => {
    const reg = new HealthRegistry();
    reg.setHealth("engine", "healthy");
    reg.setHealth("scheduler", "degraded", { reason: "scarcity" });
    expect(reg.health("engine")?.state).toBe("healthy");
    expect(reg.allHealth()).toHaveLength(2);
  });

  it("opens then half_opens then closes the circuit", () => {
    const reg = new HealthRegistry(2); // trip after 2 failures
    expect(reg.circuitState("model:yolo").state).toBe("closed");

    reg.recordFailure("model:yolo");
    expect(reg.circuitState("model:yolo").state).toBe("closed");
    reg.recordFailure("model:yolo");
    expect(reg.circuitState("model:yolo").state).toBe("open");

    reg.probe("model:yolo");
    expect(reg.circuitState("model:yolo").state).toBe("half_open");

    reg.recordSuccess("model:yolo"); // successful probe closes it
    expect(reg.circuitState("model:yolo").state).toBe("closed");
  });

  it("degrade() returns sensible actions per trigger", () => {
    const reg = new HealthRegistry();
    expect(reg.degrade("budget").actions).toContain("lightweight_model");
    expect(reg.degrade("load").actions).toContain("lower_fps");
    expect(reg.degrade("failure").actions.length).toBeGreaterThan(0);
  });
});

// ── gateway smoke ─────────────────────────────────────────────────────────────
describe("Gateway", () => {
  it("POST /query returns injected ids and GET /events streams an SSE event", async () => {
    const bus = new InProcessEventBus();
    const rec = new Recorder(bus);

    const fakeSubmit: SubmitFn = async (_query, auth: AuthContext) => {
      const traceId = "tr_gw";
      const jobId = "job_gw";
      // simulate the run path emitting a result on the shared bus, async
      setTimeout(() => {
        bus.emit(
          TOPICS.resultEvent,
          envelope(TOPICS.resultEvent, auth.tenantId, traceId, resultEvent(auth.tenantId, jobId), jobId),
        );
      }, 10);
      return { jobId, traceId };
    };

    const gw = new Gateway({ bus, recorder: rec, submit: fakeSubmit });
    const port = await gw.listen(0);
    const base = `http://127.0.0.1:${port}`;

    try {
      // POST /query
      const postRes = await fetch(`${base}/query`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-role": "analyst", "x-tenant-id": "tenant_gw" },
        body: JSON.stringify({ text: "how many white cars?" }),
      });
      expect(postRes.status).toBe(200);
      const ids = (await postRes.json()) as { jobId: string; traceId: string };
      expect(ids.jobId).toBe("job_gw");
      expect(ids.traceId).toBe("tr_gw");

      // GET /events — read at least one SSE chunk
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const evRes = await fetch(
        `${base}/events?traceId=tr_gw&tenantId=tenant_gw`,
        { signal: ctrl.signal },
      );
      expect(evRes.headers.get("content-type")).toContain("text/event-stream");

      const reader = evRes.body!.getReader();
      const { value } = await reader.read();
      const chunk = new TextDecoder().decode(value);
      expect(chunk).toContain("event: result.event");

      clearTimeout(timer);
      await reader.cancel();
    } finally {
      await gw.close();
      rec.close();
    }
  });
});
