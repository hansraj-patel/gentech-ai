/**
 * Monitor lifecycle (module 07, FR-3). A `Monitor` is a long-running, always-on
 * binding of a preset to a source: it materializes a `PipelineSpec` (reusing the
 * orchestrator) and is then represented as durable *state* (not a real thread).
 * Incoming `ResultEvent`s are fed to a `WindowAggregator`; on window close the
 * monitor's `AlertRule`s are evaluated and any crossing emits an `alert.raised`
 * via an INJECTED `emit(topic, payload)` callback keyed by the canonical `TOPICS`.
 *
 * The manager is decoupled from the control-plane — it imports nothing from
 * module 12; the event bus is injected. Reads are tenant-scoped (FR-6 of 12).
 */
import {
  makeId,
  TOPICS,
  type PipelineSpec,
  type ResultEvent,
  type TopicName,
} from "@gentech/contracts";
import { raiseAlert, evaluate, type AlertRule } from "./alerts.js";
import { WindowAggregator, type WindowAggregate, type WindowKind } from "./window.js";
import { materialize, type MaterializeContext } from "./materialize.js";
import type { PresetCategory, PresetDefinition } from "./catalog.js";

export type MonitorState = "active" | "paused" | "stopped";

export interface Monitor {
  monitorId: string;
  tenantId: string;
  sourceId: string;
  presetId: PresetCategory;
  pipelineId?: string;
  windowSec: number;
  alertRules: AlertRule[];
  state: MonitorState;
}

/** Topic + payload pair handed to the injected emitter. */
export type EmitFn = (topic: TopicName, payload: unknown) => void;

export interface DeployContext extends MaterializeContext {
  /** Override the preset's default window length (seconds). */
  windowSec?: number;
  kind?: WindowKind;
  slideSec?: number;
  /** Override the preset's default alert rules. */
  alertRules?: AlertRule[];
  /** Where alerts are published. No-op if omitted. */
  emit?: EmitFn;
}

interface MonitorRuntime {
  monitor: Monitor;
  pipeline: PipelineSpec;
  aggregator: WindowAggregator;
  emit?: EmitFn;
}

/**
 * Registry of deployed monitors. Long-running jobs are modeled as state — the
 * manager does not spawn threads; the caller drives time by forwarding the
 * `ResultEvent` stream (and clock) via `ingest`.
 */
export class MonitorManager {
  private readonly byId = new Map<string, MonitorRuntime>();

  /**
   * Deploy a preset on a source: materialize its pipeline, register a monitor in
   * the `active` state, and wire a window aggregator + alert rules. Returns the
   * Monitor (its `jobId`/pipeline is tracked internally).
   */
  async deploy(
    preset: PresetDefinition,
    params: Record<string, unknown>,
    ctx: DeployContext,
  ): Promise<Monitor> {
    const pipeline = await materialize(preset, params, ctx);
    const windowSec = ctx.windowSec ?? preset.defaultWindowSec;
    const alertRules = ctx.alertRules ?? preset.defaultAlertRules;
    const monitorId = makeId("JobId").replace("job_", "mon_");
    const sourceId = ctx.sources[0] ?? "";

    const monitor: Monitor = {
      monitorId,
      tenantId: ctx.tenantId,
      sourceId,
      presetId: preset.presetId,
      pipelineId: pipeline.pipelineId,
      windowSec,
      alertRules,
      state: "active",
    };

    const aggregator = new WindowAggregator({
      windowSec,
      kind: ctx.kind ?? "tumbling",
      slideSec: ctx.slideSec,
      jobId: monitor.monitorId,
      tenantId: ctx.tenantId,
    });

    this.byId.set(monitorId, { monitor, pipeline, aggregator, emit: ctx.emit });
    return monitor;
  }

  get(monitorId: string): Monitor | undefined {
    return this.byId.get(monitorId)?.monitor;
  }

  /** The materialized pipeline behind a monitor (for inspection / Job Detail). */
  pipelineOf(monitorId: string): PipelineSpec | undefined {
    return this.byId.get(monitorId)?.pipeline;
  }

  /** Tenant-scoped listing — never leaks monitors across tenants (FR-6). */
  list(tenantId: string): Monitor[] {
    return [...this.byId.values()]
      .map((r) => r.monitor)
      .filter((m) => m.tenantId === tenantId);
  }

  pause(monitorId: string): Monitor | undefined {
    return this.transition(monitorId, "paused");
  }

  /** Stop tears down the long-running job (its state becomes `stopped`). */
  stop(monitorId: string): Monitor | undefined {
    return this.transition(monitorId, "stopped");
  }

  /**
   * Feed one incoming `ResultEvent` for a monitor at simulated time `tNowSec`.
   * On each closed window: evaluate alert rules against the windowed metric and
   * emit `alert.raised` for every rule that crosses (FR-4/FR-5). Returns the
   * windowed aggregate ResultEvents that closed (empty while a window is open,
   * and empty entirely when the monitor is not `active`).
   */
  ingest(monitorId: string, result: ResultEvent, tNowSec: number): ResultEvent[] {
    const rt = this.byId.get(monitorId);
    if (!rt || rt.monitor.state !== "active") return [];
    if (result.tenantId !== rt.monitor.tenantId) return [];

    const flushes = rt.aggregator.add(result, tNowSec);
    const windowed: ResultEvent[] = [];
    for (const f of flushes) {
      windowed.push(f.event);
      this.evaluateAlerts(rt, f.aggregate);
    }
    return windowed;
  }

  /**
   * Advance a monitor's clock to `tNowSec` without a new result, closing any due
   * windows (used to flush trailing windows). Same alert semantics as `ingest`.
   */
  tick(monitorId: string, tNowSec: number): ResultEvent[] {
    const rt = this.byId.get(monitorId);
    if (!rt || rt.monitor.state !== "active") return [];
    const flushes = rt.aggregator.flush(tNowSec);
    const windowed: ResultEvent[] = [];
    for (const f of flushes) {
      windowed.push(f.event);
      this.evaluateAlerts(rt, f.aggregate);
    }
    return windowed;
  }

  private evaluateAlerts(rt: MonitorRuntime, agg: WindowAggregate): void {
    for (const rule of rt.monitor.alertRules) {
      const value = metricValue(rule.metric, agg);
      if (value === undefined) continue;
      if (evaluate(rule, value)) {
        const alert = raiseAlert({
          rule,
          value,
          jobId: rt.monitor.monitorId,
          tenantId: rt.monitor.tenantId,
          windowStartSec: agg.windowStartSec,
          windowEndSec: agg.windowEndSec,
          // mirror the closing window's end so alert ts never reads the wall clock
          ts: new Date(Math.round(agg.windowEndSec * 1000)).toISOString(),
        });
        rt.emit?.(TOPICS.alertRaised, alert);
      }
    }
  }

  private transition(monitorId: string, state: MonitorState): Monitor | undefined {
    const rt = this.byId.get(monitorId);
    if (!rt) return undefined;
    rt.monitor = { ...rt.monitor, state };
    this.byId.set(monitorId, rt);
    return rt.monitor;
  }
}

/** Resolve a rule's metric against a window aggregate. */
function metricValue(metric: string, agg: WindowAggregate): number | undefined {
  switch (metric) {
    case "count":
    case "matches": // matches are surfaced as the windowed count for these presets
      return agg.count;
    case "rate":
      return agg.rate;
    default:
      return undefined;
  }
}
