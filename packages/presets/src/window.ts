/**
 * Time-window analytics (module 07, FR-4). A `WindowAggregator` consumes the
 * `ResultEvent` stream produced by module 04 and emits periodic windowed
 * aggregates (count + rate) as `ResultEvent`s (kind `timeseries` for tumbling,
 * `summary` for sliding) when a window closes.
 *
 * Determinism: the aggregator never reads the wall clock. Time is supplied
 * explicitly via `tNowSec` on every `add`/`flush` call, so a `SimClock` (module
 * 13) or an injected `now` drives window boundaries reproducibly.
 */
import { z } from "zod";
import { makeId, ResultEventSchema, type ResultEvent } from "@gentech/contracts";

export const WindowKind = z.enum(["tumbling", "sliding"]);
export type WindowKind = z.infer<typeof WindowKind>;

/** The aggregate carried inside a windowed ResultEvent payload. */
export interface WindowAggregate {
  metric: "count";
  /** Number of contributing results in the window. */
  count: number;
  /** Per-second rate over the window (count / windowSec). */
  rate: number;
  windowSec: number;
  windowStartSec: number;
  windowEndSec: number;
  kind: WindowKind;
}

/** A windowed ResultEvent plus the raw aggregate, returned on window close. */
export interface WindowFlush {
  event: ResultEvent;
  aggregate: WindowAggregate;
}

export interface WindowAggregatorOptions {
  windowSec: number;
  kind?: WindowKind;
  /** Slide interval (seconds) for sliding windows; defaults to `windowSec`. */
  slideSec?: number;
  jobId: string;
  tenantId: string;
  /** How a result contributes to the window metric; default: each result = 1. */
  weightOf?: (result: ResultEvent) => number;
  /** Origin of the time axis (seconds). Windows align to this. Default 0. */
  startSec?: number;
}

interface Sample {
  tSec: number;
  weight: number;
}

/**
 * Tumbling + sliding window aggregator. Each `add` records a weighted sample at
 * an explicit time; window boundaries are checked deterministically. On close a
 * windowed aggregate is emitted as a `ResultEvent`.
 *
 * - **tumbling**: disjoint, fixed-width windows. A new event time `>=` the
 *   current window end closes (one or more) windows.
 * - **sliding**: windows of width `windowSec` advancing by `slideSec`. Each
 *   `slideSec` boundary closes a window covering the trailing `windowSec`.
 */
export class WindowAggregator {
  readonly windowSec: number;
  readonly kind: WindowKind;
  readonly slideSec: number;

  private readonly jobId: string;
  private readonly tenantId: string;
  private readonly weightOf: (result: ResultEvent) => number;

  /** Next boundary at which a window closes (tumbling end / next slide point). */
  private nextBoundarySec: number;
  /** Tumbling accumulator (cleared each window). */
  private tumblingCount = 0;
  private windowStartSec: number;
  /** Sliding retains recent samples to recompute the trailing window. */
  private readonly samples: Sample[] = [];

  constructor(opts: WindowAggregatorOptions) {
    if (opts.windowSec <= 0) throw new Error("windowSec must be positive");
    this.windowSec = opts.windowSec;
    this.kind = opts.kind ?? "tumbling";
    this.slideSec = opts.slideSec ?? opts.windowSec;
    if (this.slideSec <= 0) throw new Error("slideSec must be positive");
    this.jobId = opts.jobId;
    this.tenantId = opts.tenantId;
    this.weightOf = opts.weightOf ?? (() => 1);
    this.windowStartSec = opts.startSec ?? 0;
    this.nextBoundarySec =
      this.kind === "tumbling"
        ? this.windowStartSec + this.windowSec
        : this.windowStartSec + this.slideSec;
  }

  /**
   * Feed one result observed at `tNowSec`. Returns any windows that closed at or
   * before this time (usually 0 or 1; more if the clock jumped past several).
   */
  add(result: ResultEvent, tNowSec: number): WindowFlush[] {
    const flushed = this.flush(tNowSec);
    const weight = this.weightOf(result);
    if (this.kind === "tumbling") {
      this.tumblingCount += weight;
    } else {
      this.samples.push({ tSec: tNowSec, weight });
    }
    return flushed;
  }

  /**
   * Advance the clock to `tNowSec` without adding a result, closing every window
   * whose boundary has been reached. Used to drain windows on a tick or at end.
   */
  flush(tNowSec: number): WindowFlush[] {
    const out: WindowFlush[] = [];
    while (tNowSec >= this.nextBoundarySec) {
      out.push(this.closeWindow(this.nextBoundarySec));
      if (this.kind === "tumbling") {
        this.windowStartSec = this.nextBoundarySec;
        this.nextBoundarySec += this.windowSec;
        this.tumblingCount = 0;
      } else {
        this.nextBoundarySec += this.slideSec;
        this.pruneSamples(this.nextBoundarySec - this.windowSec);
      }
    }
    return out;
  }

  private closeWindow(endSec: number): WindowFlush {
    const startSec = this.kind === "tumbling" ? this.windowStartSec : endSec - this.windowSec;
    const count =
      this.kind === "tumbling"
        ? this.tumblingCount
        : this.samples.reduce((s, x) => (x.tSec > startSec && x.tSec <= endSec ? s + x.weight : s), 0);
    const aggregate: WindowAggregate = {
      metric: "count",
      count,
      rate: count / this.windowSec,
      windowSec: this.windowSec,
      windowStartSec: startSec,
      windowEndSec: endSec,
      kind: this.kind,
    };
    const event = ResultEventSchema.parse({
      resultId: makeId("ResultId"),
      jobId: this.jobId,
      tenantId: this.tenantId,
      kind: this.kind === "tumbling" ? "timeseries" : "summary",
      partial: false,
      payload: aggregate,
      ts: secToIso(endSec),
    });
    return { event, aggregate };
  }

  private pruneSamples(beforeSec: number): void {
    while (this.samples.length && this.samples[0]!.tSec <= beforeSec) {
      this.samples.shift();
    }
  }
}

/** Map an integer-second offset onto a deterministic RFC-3339 timestamp. */
function secToIso(sec: number): string {
  return new Date(Math.round(sec * 1000)).toISOString();
}
