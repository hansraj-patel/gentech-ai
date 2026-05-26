/**
 * Health & resilience registry (module 12, §7). Tracks a per-module
 * `HealthStatus`, and wraps the engine's `CircuitBreaker` to expose a richer
 * `CircuitState` (closed → open → half_open) per target. `degrade(trigger)`
 * maps an overload/failure/budget signal to a `DegradationPolicy` of concrete
 * actions the rest of the platform can apply.
 */
import type {
  CircuitState,
  DegradationPolicy,
  HealthStatus,
} from "@gentech/contracts";
import { CircuitBreaker } from "@gentech/engine";

const now = (): string => new Date().toISOString();

/** Per-target circuit bookkeeping layered over the engine's breaker. */
interface CircuitEntry {
  breaker: CircuitBreaker;
  attempts: number;
  failures: number;
  /** half_open is entered explicitly via `probe()` after the breaker tripped. */
  halfOpen: boolean;
  since: string;
}

export class HealthRegistry {
  private readonly modules = new Map<string, HealthStatus>();
  private readonly circuits = new Map<string, CircuitEntry>();

  constructor(private readonly threshold = 3) {}

  // ── module health ─────────────────────────────────────────────────────────
  /** Record/replace a module's health snapshot. */
  setHealth(
    module: string,
    state: HealthStatus["state"],
    details?: unknown,
  ): HealthStatus {
    const status: HealthStatus = { module, state, lastCheck: now(), details };
    this.modules.set(module, status);
    return status;
  }

  health(module: string): HealthStatus | undefined {
    return this.modules.get(module);
  }

  allHealth(): HealthStatus[] {
    return [...this.modules.values()];
  }

  // ── circuit breaker (wrapping engine CircuitBreaker) ───────────────────────
  /** Record a success against a target; closes a half_open circuit. */
  recordSuccess(target: string): void {
    const c = this.circuit(target);
    c.attempts += 1;
    if (c.halfOpen) {
      // A successful probe closes the circuit: reset to a fresh breaker.
      this.circuits.set(target, this.freshEntry());
    }
  }

  /** Record a failure; trips the underlying breaker once the threshold is hit. */
  recordFailure(target: string): void {
    const c = this.circuit(target);
    c.attempts += 1;
    c.failures += 1;
    c.halfOpen = false; // a failed probe re-opens the circuit
    c.breaker.recordFailure(target);
  }

  /**
   * Move an open circuit to `half_open` to allow a single probe. No-op if the
   * circuit is still closed (never tripped).
   */
  probe(target: string): void {
    const c = this.circuit(target);
    if (c.breaker.isOpen(target)) c.halfOpen = true;
  }

  /** Current circuit state for a target. Unknown targets are `closed`. */
  circuitState(target: string): CircuitState {
    const c = this.circuit(target);
    const open = c.breaker.isOpen(target);
    const state: CircuitState["state"] = c.halfOpen
      ? "half_open"
      : open
        ? "open"
        : "closed";
    const failureRate = c.attempts === 0 ? 0 : c.failures / c.attempts;
    return { target, state, failureRate, since: c.since };
  }

  // ── degradation policy ──────────────────────────────────────────────────────
  /** Map a degradation trigger to concrete, prioritized actions (§7). */
  degrade(trigger: DegradationPolicy["trigger"]): DegradationPolicy {
    switch (trigger) {
      case "budget":
        // Spend pressure → cheaper models + drop work that isn't critical.
        return { trigger, actions: ["lightweight_model", "defer_noncritical"] };
      case "load":
        // Throughput pressure → shed pixels before shedding jobs.
        return { trigger, actions: ["lower_fps", "lower_res", "defer_noncritical"] };
      case "failure":
        // Reliability pressure → simpler models + drop non-critical paths.
        return { trigger, actions: ["lightweight_model", "lower_fps", "defer_noncritical"] };
    }
  }

  private circuit(target: string): CircuitEntry {
    let c = this.circuits.get(target);
    if (!c) {
      c = this.freshEntry();
      this.circuits.set(target, c);
    }
    return c;
  }

  private freshEntry(): CircuitEntry {
    return {
      breaker: new CircuitBreaker(this.threshold),
      attempts: 0,
      failures: 0,
      halfOpen: false,
      since: now(),
    };
  }
}
