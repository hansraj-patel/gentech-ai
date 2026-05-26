/**
 * MockBackend — the single authoritative fake backend (module 13). It implements
 * the same method surface the engine's InferenceClient + ComputeClient ports expect
 * (structural typing; no import of the engine, so there's no dependency cycle), so
 * going live later = pointing the engine at a real endpoint instead of this. Holds
 * the active scenario/seed/clock and serves inference, inventory, and lease calls.
 */
import type {
  ComputeRequest,
  GpuInventory,
  InferenceRequest,
  InferenceResponse,
} from "@gentech/contracts";
import { SimClock, type FiredEvent } from "./clock.js";
import { inferFromGroundTruth } from "./infer.js";
import { buildInventory, leaseFeasibility, type LeaseFeasibility } from "./inventory.js";
import { getScenario, type Scenario } from "./scenarios.js";

export interface MockBackendOptions {
  scenarioId?: string;
  seed?: string | number;
  speed?: number;
  /** Optional registry-backed latency (module 06 metadata) for realistic timing. */
  latencyLookup?: (modelId: string) => number | undefined;
}

export class MockBackend {
  private scenario: Scenario;
  private seed: string | number;
  private clock: SimClock;
  private readonly latencyLookup?: (modelId: string) => number | undefined;
  private queueDepth = 0;

  constructor(opts: MockBackendOptions = {}) {
    this.scenario = getScenario(opts.scenarioId ?? "parking_lot_daytime");
    this.seed = opts.seed ?? "default";
    this.clock = new SimClock(opts.speed ?? 1, this.scenario);
    this.latencyLookup = opts.latencyLookup;
  }

  /** Stands in for module 06's POST /infer. Derives output from ground truth. */
  async infer(req: InferenceRequest): Promise<InferenceResponse> {
    return inferFromGroundTruth(req, this.scenario, {
      seed: this.seed,
      latencyLookup: this.latencyLookup,
    });
  }

  /** Stands in for module 05's physical layer: a fluctuating GpuInventory (FR-4). */
  async inventory(): Promise<GpuInventory> {
    return buildInventory(
      this.scenario,
      this.clock.tNow,
      this.seed,
      this.clock.runningJobs.size,
      this.queueDepth,
    );
  }

  /** Grant/deny a lease consistently with current inventory (FR-5). */
  async leaseFeasibility(req: ComputeRequest): Promise<LeaseFeasibility> {
    const inv = await this.inventory();
    const result = leaseFeasibility(req, inv);
    if (!result.grantable) this.queueDepth += 1;
    return result;
  }

  // ── control surface (FR-7) ──────────────────────────────────────────────────
  setScenario(scenarioId: string, seed?: string | number, speed?: number): void {
    this.scenario = getScenario(scenarioId);
    if (seed !== undefined) this.seed = seed;
    this.clock = new SimClock(speed ?? this.clock.speed, this.scenario);
    this.queueDepth = 0;
  }

  /** Advance the simulated clock; returns events that fired (drives alerts, FR-6). */
  advance(ticks = 1): FiredEvent[] {
    return this.clock.advance(ticks);
  }

  markJobRunning(jobId: string): void {
    this.clock.runningJobs.add(jobId);
  }
  markJobDone(jobId: string): void {
    this.clock.runningJobs.delete(jobId);
  }

  state() {
    return {
      scenarioId: this.scenario.scenarioId,
      seed: this.seed,
      segmentCount: this.scenario.segmentCount,
      clock: this.clock.snapshot(),
      queueDepth: this.queueDepth,
    };
  }

  get activeScenario(): Scenario {
    return this.scenario;
  }
}
