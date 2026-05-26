/**
 * Synthetic GPU/infra state (module 13, FR-4/FR-5). Serves a fluctuating
 * GpuInventory and answers lease-feasibility consistently with it, so the scheduler
 * (05) and cost (11) see realistic, changing inputs — and scarcity scenarios
 * actually cause work to be deprioritized/degraded.
 */
import type { ComputeRequest, GpuInventory } from "@gentech/contracts";
import { GpuInventorySchema } from "@gentech/contracts";
import { Rng } from "./rng.js";
import type { Scenario } from "./scenarios.js";

/** Fraction of each class that's free, as a function of load profile + clock. */
function availabilityFraction(profile: Scenario["infra"]["loadProfile"], tNow: number, rng: Rng): number {
  switch (profile) {
    case "scarce":
      return rng.range(0.05, 0.2);
    case "bursty": {
      // oscillate between busy and idle over the simulated clock
      const wave = (Math.sin(tNow / 7) + 1) / 2; // 0..1
      return 0.15 + wave * 0.7;
    }
    case "steady":
    default:
      return rng.range(0.5, 0.7);
  }
}

export function buildInventory(
  scenario: Scenario,
  tNow: number,
  seed: string | number,
  runningJobs: number,
  queueDepth: number,
): GpuInventory {
  const rng = new Rng(seed, "inventory", Math.floor(tNow));
  const total = scenario.infra.gpuTotals;
  const available: Record<string, number> = {};
  for (const [cls, n] of Object.entries(total)) {
    if (cls === "none") {
      available[cls] = n; // CPU-only capacity is effectively unbounded
      continue;
    }
    const frac = availabilityFraction(scenario.infra.loadProfile, tNow, new Rng(rng.float(), cls));
    available[cls] = Math.max(0, Math.round(n * frac));
  }
  return GpuInventorySchema.parse({
    total,
    available,
    runningJobs,
    queueDepth,
    updatedAt: new Date(Date.UTC(2026, 4, 26) + Math.floor(tNow) * 1000).toISOString(),
  }) as GpuInventory;
}

export interface LeaseFeasibility {
  grantable: boolean;
  gpuClass: string;
  endpoint?: string;
  reason?: string;
}

/** Grant/deny consistent with current inventory (FR-5). CPU-only always grantable. */
export function leaseFeasibility(req: ComputeRequest, inv: GpuInventory): LeaseFeasibility {
  const gpuClass = req.gpuClass ?? "none";
  if (gpuClass === "none") {
    return { grantable: true, gpuClass, endpoint: "mock://worker/cpu" };
  }
  const free = inv.available[gpuClass] ?? 0;
  if (free >= 1) {
    return { grantable: true, gpuClass, endpoint: `mock://worker/${gpuClass}` };
  }
  return { grantable: false, gpuClass, reason: `no ${gpuClass} GPUs available (queueDepth=${inv.queueDepth})` };
}
