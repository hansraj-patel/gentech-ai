/**
 * Time-simulation engine (module 13, FR-6). A simulated clock the demo advances so
 * jobs progress, GPU availability drifts, and scenario events fire on schedule —
 * exercising progressive results and live alerts without real time passing.
 */
import type { Scenario } from "./scenarios.js";

export interface FiredEvent {
  kind: string;
  atTime: number;
  firedAt: number;
}

export class SimClock {
  tNow = 0;
  readonly runningJobs = new Set<string>();
  private firedKinds = new Set<string>();

  constructor(
    public speed: number,
    private readonly scenario: Scenario,
  ) {}

  /** Advance the clock; return any scenario events that fire as a result (FR-6). */
  advance(ticks = 1): FiredEvent[] {
    this.tNow += ticks * this.speed;
    const fired: FiredEvent[] = [];
    for (const e of this.scenario.groundTruth.events) {
      const key = `${e.kind}@${e.atTime}`;
      if (e.atTime <= this.tNow && !this.firedKinds.has(key)) {
        this.firedKinds.add(key);
        fired.push({ kind: e.kind, atTime: e.atTime, firedAt: this.tNow });
      }
    }
    return fired;
  }

  snapshot() {
    return { tNow: this.tNow, speed: this.speed, runningJobs: [...this.runningJobs] };
  }
}
