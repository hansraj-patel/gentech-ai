/**
 * Presets ↔ bus binding (module 12 ↔ module 07). A thin adapter that connects a
 * `MonitorManager` to the shared `InProcessEventBus`:
 *
 *   bus.subscribe(TOPICS.resultEvent) → monitor.ingest(...) → bus.emit(TOPICS.alertRaised)
 *
 * `@gentech/presets` stays fully decoupled — it imports nothing from the control
 * plane and already accepts an injected `emit`. This adapter is the only place
 * that knows about both: it feeds the bus's `result.event` stream into the
 * monitor's window aggregator and republishes any `alert.raised` the monitor's
 * `AlertRule`s produce back onto the same bus.
 */
import { makeId, TOPICS, type Event, type ResultEvent } from "@gentech/contracts";
import type { InProcessEventBus, Unsubscribe } from "./bus.js";

/** The slice of `MonitorManager` (module 07) this adapter drives. */
export interface MonitorLike {
  ingest(monitorId: string, result: ResultEvent, tNowSec: number): ResultEvent[];
}

export interface BindMonitorOptions {
  /** The deployed monitor's id to feed. */
  monitorId: string;
  /**
   * Map a `result.event` to the simulated window time (seconds). Default reads
   * the event payload's `ts`/`windowEndSec` or falls back to the envelope `ts`.
   */
  timeOf?: (event: Event, result: ResultEvent) => number;
  /** Restrict feeding to a single tenant (defence-in-depth; monitor also filters). */
  tenantId?: string;
}

/**
 * Subscribe `manager` to the bus's `result.event` stream so each result is fed to
 * the named monitor's window aggregator; when a window closes and an `AlertRule`
 * crosses, the monitor emits `alert.raised` — which this adapter republishes onto
 * the same bus (as a §7 event envelope). Returns an unsubscribe.
 *
 * The monitor's own `emit` (passed at `deploy` time) should be the `emit` this
 * adapter installs — wire it via `makeMonitorEmit(bus, ...)` below.
 */
export function bindMonitorToBus(
  bus: InProcessEventBus,
  manager: MonitorLike,
  opts: BindMonitorOptions,
): Unsubscribe {
  const timeOf = opts.timeOf ?? defaultTimeOf;
  return bus.subscribe(TOPICS.resultEvent, (event: Event) => {
    const result = event.payload as ResultEvent;
    if (opts.tenantId !== undefined && event.tenantId !== opts.tenantId) return;
    // Don't feed alert/window-derived results back in (avoid feedback loops).
    if (event.type === TOPICS.alertRaised) return;
    manager.ingest(opts.monitorId, result, timeOf(event, result));
  });
}

/**
 * Build the `emit(topic, payload)` callback to hand a `MonitorManager` at deploy
 * time so its `alert.raised` payloads are published as proper §7 events on `bus`.
 * Tenant/trace are supplied by the caller (the monitor knows neither the trace).
 */
export function makeMonitorEmit(
  bus: InProcessEventBus,
  ctx: { tenantId: string; traceId?: string },
): (topic: string, payload: unknown) => void {
  const traceId = ctx.traceId ?? makeId("PipelineId").replace("pipe_", "trace_");
  return (topic, payload) => {
    const result = payload as Partial<ResultEvent>;
    const event: Event = {
      eventId: makeId("EventId"),
      type: topic,
      tenantId: ctx.tenantId,
      ...(result.jobId ? { jobId: result.jobId } : {}),
      ts: typeof result.ts === "string" ? result.ts : new Date().toISOString(),
      traceId,
      payload,
    };
    bus.emit(topic, event);
  };
}

/** Resolve a window time from a result event (seconds since the time origin). */
function defaultTimeOf(event: Event, result: ResultEvent): number {
  const payload = result.payload as { windowEndSec?: number } | undefined;
  if (payload && typeof payload.windowEndSec === "number") return payload.windowEndSec;
  const ts = result.ts ?? event.ts;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms / 1000 : 0;
}
