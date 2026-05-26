import type { ModelMetadata, QualityTier } from "@gentech/contracts";
import { CATALOG } from "./catalog.js";

const TIER_RANK: Record<QualityTier, number> = { low: 0, standard: 1, high: 2 };

export interface FindModelsConstraints {
  /** Floor on quality tier; candidates below it are excluded. */
  minQuality?: QualityTier;
  /** Upper bound on per-segment latency estimate. */
  maxLatencyMs?: number;
}

/** A snapshot of the registry — pass `CATALOG` in production, a fixture in tests. */
export class ModelRegistry {
  private readonly byTask = new Map<string, ModelMetadata[]>();
  readonly modelIds: ReadonlySet<string>;

  constructor(models: readonly ModelMetadata[] = CATALOG) {
    const ids = new Set<string>();
    for (const model of models) {
      ids.add(model.modelId);
      const list = this.byTask.get(model.task) ?? [];
      list.push(model);
      this.byTask.set(model.task, list);
    }
    this.modelIds = ids;
  }

  has(modelId: string): boolean {
    return this.modelIds.has(modelId);
  }

  get(modelId: string): ModelMetadata | undefined {
    for (const list of this.byTask.values()) {
      const found = list.find((m) => m.modelId === modelId);
      if (found) return found;
    }
    return undefined;
  }

  tasks(): string[] {
    return [...this.byTask.keys()].sort();
  }

  /**
   * Candidate models for a capability, filtered by constraints and ranked
   * **deterministically** (cheapest-first within the quality floor): costWeight
   * asc → latency asc → modelId asc. The orchestrator's resolver picks index 0
   * for the cost-conscious default and walks the list to degrade.
   */
  findModels(task: string, constraints: FindModelsConstraints = {}): ModelMetadata[] {
    const floor = constraints.minQuality ? TIER_RANK[constraints.minQuality] : -1;
    return (this.byTask.get(task) ?? [])
      .filter((model) => (TIER_RANK[model.qualityTier] ?? 0) >= floor)
      .filter((model) =>
        constraints.maxLatencyMs === undefined
          ? true
          : model.latencyMsEst <= constraints.maxLatencyMs,
      )
      .sort(
        (a, b) =>
          a.costWeight - b.costWeight ||
          a.latencyMsEst - b.latencyMsEst ||
          a.modelId.localeCompare(b.modelId),
      );
  }
}

/** Default singleton over the real catalog. */
export const defaultRegistry = new ModelRegistry();
