import { describe, it, expect } from "vitest";
import {
  orchestrate,
  buildQuery,
  RuleBasedPlanner,
  validatePipelineSpec,
  defaultRegistry,
  type CapabilityPlan,
  type Planner,
  type PlanInput,
} from "./harness.js";

/** A scripted planner: returns a fixed plan, or a sequence (for repair tests). */
class MockPlanner implements Planner {
  readonly name = "mock";
  private calls = 0;
  constructor(private readonly responses: unknown[]) {}
  attempts(): number {
    return this.calls;
  }
  async plan(_input: PlanInput): Promise<CapabilityPlan> {
    const idx = Math.min(this.calls, this.responses.length - 1);
    this.calls++;
    return this.responses[idx] as CapabilityPlan;
  }
}

const whiteCarsPlan: CapabilityPlan = {
  rationale: "count white cars",
  nodes: [
    { nodeId: "detect", task: "object_detection", params: { classes: ["car"] }, parallelizable: true, dependsOn: [] },
    { nodeId: "vclass", task: "vehicle_classification", params: {}, parallelizable: true, dependsOn: ["detect"] },
    { nodeId: "color", task: "color_classification", params: { color: "white" }, parallelizable: true, dependsOn: ["vclass"] },
    { nodeId: "count", task: "counting", params: {}, parallelizable: false, dependsOn: ["color"] },
  ],
};

describe("orchestrate — golden DAGs (FR-1, FR-5)", () => {
  it("'how many white cars?' → detection→vehicle-class→color→count with sensible models", async () => {
    const planner = new MockPlanner([whiteCarsPlan]);
    const q = buildQuery({ text: "how many white cars?" });
    const { pipeline, cost } = await orchestrate(q, { planner });

    expect(pipeline.nodes.map((n) => n.task)).toEqual([
      "object_detection",
      "vehicle_classification",
      "color_classification",
      "counting",
    ]);
    expect(pipeline.edges).toEqual([
      { from: "detect", to: "vclass" },
      { from: "vclass", to: "color" },
      { from: "color", to: "count" },
    ]);
    // cheapest models picked under default (no quality floor)
    expect(pipeline.nodes.map((n) => n.modelId)).toEqual([
      "yolo-n",
      "vehicle-cls-lite",
      "color-net",
      "counter",
    ]);
    expect(cost.credits).toBeGreaterThan(0);
  });

  it("plate search → detection→anpr→tracking→match (via rules planner)", async () => {
    const q = buildQuery({ text: "find the car with number plate ABC1234" });
    const { pipeline } = await orchestrate(q, { planner: new RuleBasedPlanner() });
    const tasks = new Set(pipeline.nodes.map((n) => n.task));
    expect(tasks).toEqual(new Set(["object_detection", "anpr_ocr", "tracking", "match_filtering"]));
  });
});

describe("orchestrate — invariants (acceptance criteria)", () => {
  const queries = [
    "how many white cars?",
    "count the people",
    "find number plate XY12ABC",
    "how many trucks today",
  ];
  it("every generated pipeline is acyclic and fully model-resolvable", async () => {
    for (const text of queries) {
      const { pipeline } = await orchestrate(buildQuery({ text }), { planner: new RuleBasedPlanner() });
      // validatePipelineSpec re-checks schema + acyclicity + model resolvability
      expect(() => validatePipelineSpec(pipeline, defaultRegistry.modelIds)).not.toThrow();
      for (const n of pipeline.nodes) expect(defaultRegistry.has(n.modelId)).toBe(true);
    }
  });
});

describe("orchestrate — budget degradation (FR-8)", () => {
  it("degrades a high-quality plan to fit a low maxCredits cap", async () => {
    const planner = new MockPlanner([whiteCarsPlan]);
    const q = buildQuery({ text: "how many white cars?", constraints: { minQuality: "high", maxCredits: 50 } });
    const { cost, degraded } = await orchestrate(q, { planner });
    expect(degraded).toBe(true);
    expect(cost.credits).toBeLessThanOrEqual(50);
  });

  it("throws BUDGET_EXCEEDED when even the cheapest pipeline is too dear", async () => {
    const planner = new MockPlanner([whiteCarsPlan]);
    const q = buildQuery({ text: "how many white cars?", constraints: { maxCredits: 1 } });
    await expect(orchestrate(q, { planner })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });
});

describe("orchestrate — repair loop & fallback", () => {
  it("repairs after an invalid plan, then succeeds", async () => {
    const planner = new MockPlanner([
      { nodes: [{ nodeId: "x", task: "teleportation", dependsOn: [] }], rationale: "bad" }, // unknown task
      whiteCarsPlan, // fixed on retry
    ]);
    const { pipeline, plannerUsed } = await orchestrate(buildQuery({ text: "how many white cars?" }), { planner });
    expect(plannerUsed).toBe("mock");
    expect(planner.attempts()).toBe(2);
    expect(pipeline.nodes).toHaveLength(4);
  });

  it("falls back to the rules planner when the LLM never produces a valid plan", async () => {
    const alwaysBad = new MockPlanner([{ nodes: [{ nodeId: "x", task: "nope", dependsOn: [] }], rationale: "" }]);
    const { plannerUsed, pipeline } = await orchestrate(buildQuery({ text: "how many white cars?" }), {
      planner: alwaysBad,
      maxRepairs: 1,
    });
    expect(plannerUsed).toBe("rule-based-fallback");
    expect(pipeline.nodes.length).toBeGreaterThan(0);
  });
});
