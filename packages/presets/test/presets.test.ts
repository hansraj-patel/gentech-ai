import { describe, it, expect } from "vitest";
import { validatePipelineSpec, makeId, type ResultEvent } from "@gentech/contracts";
import { RuleBasedPlanner } from "@gentech/orchestrator";
import { SimClock } from "@gentech/mock-server";
import {
  PRESETS,
  listPresets,
  getPreset,
  materialize,
  WindowAggregator,
  AlertRuleSchema,
  evaluate,
  MonitorManager,
  type AlertRaised,
  type WindowAggregate,
} from "../dist/index.js";

const TENANT = makeId("TenantId", "acme");
const OTHER_TENANT = makeId("TenantId", "globex");

function result(tenantId = TENANT): ResultEvent {
  return {
    resultId: makeId("ResultId"),
    jobId: makeId("JobId", "j1"),
    tenantId,
    kind: "detections",
    partial: true,
    payload: {},
    ts: new Date(0).toISOString(),
  };
}

// ── FR-1: every preset materializes to a valid PipelineSpec ───────────────────
describe("preset catalog → PipelineSpec (FR-1)", () => {
  it("ships exactly the 5 documented presets", () => {
    const ids = listPresets().map((p) => p.presetId).sort();
    expect(ids).toEqual(
      [
        "crowd_analytics",
        "intrusion_detection",
        "license_plate_scan",
        "queue_monitoring",
        "vehicle_counting",
      ].sort(),
    );
  });

  for (const preset of Object.values(PRESETS)) {
    it(`${preset.presetId} materializes to a spec that passes validatePipelineSpec`, async () => {
      const spec = await materialize(
        preset,
        {},
        {
          planner: new RuleBasedPlanner(),
          sources: [makeId("SourceId", "cam1")],
          tenantId: TENANT,
        },
      );
      expect(() => validatePipelineSpec(spec)).not.toThrow();
      expect(spec.nodes.length).toBeGreaterThan(0);
      expect(spec.tenantId).toBe(TENANT);
    });
  }

  it("getPreset rejects an unknown id", () => {
    expect(() => getPreset("nope")).toThrow();
    expect(getPreset("vehicle_counting").presetId).toBe("vehicle_counting");
  });
});

// ── FR-4: tumbling window aggregates N results into one windowed event ────────
describe("tumbling window aggregation (FR-4)", () => {
  it("aggregates N results into one windowed ResultEvent at window close", () => {
    const agg = new WindowAggregator({
      windowSec: 10,
      kind: "tumbling",
      jobId: makeId("JobId", "w1"),
      tenantId: TENANT,
    });

    // 3 results inside [0,10) — no window has closed yet
    let flushed = agg.add(result(), 1);
    flushed = flushed.concat(agg.add(result(), 4));
    flushed = flushed.concat(agg.add(result(), 9));
    expect(flushed).toHaveLength(0);

    // a result at t=10 closes window [0,10) carrying count=3
    const close = agg.add(result(), 10);
    expect(close).toHaveLength(1);
    expect(close[0]!.event.kind).toBe("timeseries");
    const a = close[0]!.aggregate;
    expect(a.count).toBe(3);
    expect(a.rate).toBeCloseTo(0.3);
    expect(a.windowStartSec).toBe(0);
    expect(a.windowEndSec).toBe(10);
  });

  it("sliding window emits summary events on each slide", () => {
    const agg = new WindowAggregator({
      windowSec: 10,
      kind: "sliding",
      slideSec: 5,
      jobId: makeId("JobId", "w2"),
      tenantId: TENANT,
    });
    agg.add(result(), 2);
    agg.add(result(), 7);
    const out = agg.flush(20); // slides close at 5,10,15,20
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((f) => f.event.kind === "summary")).toBe(true);
  });
});

// ── FR-5: AlertRule fires exactly when the windowed metric crosses ────────────
describe("alert threshold crossing (FR-5)", () => {
  it("evaluate() compares with the configured op", () => {
    const rule = AlertRuleSchema.parse({
      ruleId: "r",
      metric: "count",
      op: ">=",
      threshold: 3,
      windowSec: 10,
    });
    expect(evaluate(rule, 2)).toBe(false);
    expect(evaluate(rule, 3)).toBe(true);
    expect(evaluate(rule, 4)).toBe(true);
  });

  it("monitor emits alert.raised when (and only when) the window crosses", async () => {
    const clock = new SimClock(1, { groundTruth: { events: [] } } as never);
    const emitted: { topic: string; event: ResultEvent }[] = [];
    const mgr = new MonitorManager();

    const monitor = await mgr.deploy(
      getPreset("queue_monitoring"),
      {},
      {
        planner: new RuleBasedPlanner(),
        sources: [makeId("SourceId", "cam1")],
        tenantId: TENANT,
        windowSec: 10,
        alertRules: [
          AlertRuleSchema.parse({
            ruleId: "q",
            metric: "count",
            op: ">=",
            threshold: 3,
            windowSec: 10,
          }),
        ],
        emit: (topic, payload) => emitted.push({ topic, event: payload as ResultEvent }),
      },
    );

    // Window 1: only 2 results → below threshold, no alert at close (t=10).
    clock.advance(2);
    mgr.ingest(monitor.monitorId, result(), clock.tNow); // t=2
    clock.advance(2);
    mgr.ingest(monitor.monitorId, result(), clock.tNow); // t=4
    clock.advance(6);
    const w1 = mgr.tick(monitor.monitorId, clock.tNow); // t=10 closes window [0,10)
    expect(w1).toHaveLength(1);
    expect((w1[0]!.payload as WindowAggregate).count).toBe(2);
    expect(emitted).toHaveLength(0);

    // Window 2: 3 results → crosses threshold → exactly one alert at close (t=20).
    mgr.ingest(monitor.monitorId, result(), 11);
    mgr.ingest(monitor.monitorId, result(), 12);
    mgr.ingest(monitor.monitorId, result(), 13);
    clock.advance(10);
    mgr.tick(monitor.monitorId, 20); // closes window [10,20)
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.topic).toBe("alert.raised");
    expect(emitted[0]!.event.kind).toBe("summary"); // alert.raised is a ResultEvent
    const alert = emitted[0]!.event.payload as AlertRaised;
    expect(alert.value).toBe(3);
    expect(alert.ruleId).toBe("q");
  });
});

// ── FR-3: monitor lifecycle + tenant-scoped list ──────────────────────────────
describe("monitor lifecycle (FR-3)", () => {
  async function deploy(mgr: MonitorManager, tenantId: string) {
    return mgr.deploy(
      getPreset("vehicle_counting"),
      {},
      {
        planner: new RuleBasedPlanner(),
        sources: [makeId("SourceId", "lane")],
        tenantId,
      },
    );
  }

  it("deploy → active, then pause and stop transition state", async () => {
    const mgr = new MonitorManager();
    const m = await deploy(mgr, TENANT);
    expect(m.state).toBe("active");
    expect(m.pipelineId).toBeDefined();
    expect(mgr.pipelineOf(m.monitorId)).toBeDefined();

    expect(mgr.pause(m.monitorId)!.state).toBe("paused");
    // a paused monitor ingests nothing
    expect(mgr.ingest(m.monitorId, result(), 100)).toHaveLength(0);

    expect(mgr.stop(m.monitorId)!.state).toBe("stopped");
    expect(mgr.get(m.monitorId)!.state).toBe("stopped");
  });

  it("list is tenant-scoped", async () => {
    const mgr = new MonitorManager();
    await deploy(mgr, TENANT);
    await deploy(mgr, TENANT);
    await deploy(mgr, OTHER_TENANT);

    expect(mgr.list(TENANT)).toHaveLength(2);
    expect(mgr.list(OTHER_TENANT)).toHaveLength(1);
    expect(mgr.list(TENANT).every((m) => m.tenantId === TENANT)).toBe(true);
  });

  it("ingest ignores cross-tenant results", async () => {
    const mgr = new MonitorManager();
    const m = await deploy(mgr, TENANT);
    // a foreign-tenant result must not contribute to this monitor's window
    const out = mgr.ingest(m.monitorId, result(OTHER_TENANT), 1000);
    expect(out).toHaveLength(0);
  });
});
