import { describe, it, expect } from "vitest";
import { estimate, checkBudget } from "../dist/index.js";
import { defaultRegistry } from "@gentech/model-registry";
import type { BudgetPolicy, PipelineSpec } from "@gentech/contracts";

const spec: PipelineSpec = {
  pipelineId: "pipe_x",
  queryId: "query_x",
  tenantId: "ten_x",
  nodes: [
    {
      nodeId: "detect",
      task: "object_detection",
      modelId: "yolo-n",
      params: {},
      compute: { gpuClass: "small", minVramGb: 2, estDurationSec: 1, priority: 5 },
      parallelizable: true,
    },
    {
      nodeId: "count",
      task: "counting",
      modelId: "counter",
      params: {},
      compute: { gpuClass: "none", minVramGb: 0, estDurationSec: 1, priority: 5 },
      parallelizable: false,
    },
  ],
  edges: [{ from: "detect", to: "count" }],
  retryPolicy: { maxRetries: 2, backoff: "exponential", deadLetter: true },
};

describe("estimate", () => {
  it("produces integer credits, a per-node breakdown, and a critical-path runtime", () => {
    const e = estimate(spec, defaultRegistry);
    expect(Number.isInteger(e.credits)).toBe(true);
    expect(e.credits).toBeGreaterThan(0);
    expect(e.breakdown).toHaveLength(2);
    expect(e.gpuClassEst).toBe("small"); // dominant resource across nodes
    expect(e.runtimeSecEst).toBeGreaterThan(0);
    expect(e.confidence).toBe("medium"); // gpu-seconds stubbed in v1
  });
});

describe("checkBudget", () => {
  const budget = (over: Partial<BudgetPolicy> = {}): BudgetPolicy => ({
    budgetRef: "bud_1",
    tenantId: "ten_x",
    scope: "tenant",
    capCredits: 100,
    period: "monthly",
    spent: 0,
    emergencyCutoff: false,
    ...over,
  });

  it("allows when no budget is set", () => {
    expect(checkBudget(999, undefined).allow).toBe(true);
  });
  it("allows under the cap and denies over it", () => {
    expect(checkBudget(50, budget()).allow).toBe(true);
    expect(checkBudget(150, budget()).allow).toBe(false);
  });
  it("hard-stops on emergency cutoff once exhausted", () => {
    expect(checkBudget(1, budget({ spent: 100, emergencyCutoff: true })).allow).toBe(false);
  });
});
