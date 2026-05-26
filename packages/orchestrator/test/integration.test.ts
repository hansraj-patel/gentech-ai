import { describe, it, expect } from "vitest";
import { orchestrate, buildQuery, validatePipelineSpec, defaultRegistry } from "./harness.js";
import { AnthropicPlanner } from "../dist/index.js";

/**
 * Opt-in: only runs when ANTHROPIC_API_KEY is present. Proves the *real* LLM path
 * produces a plan that survives validation + resolution. Kept out of the default
 * CI signal so the suite stays fast, free, and offline-deterministic.
 */
const runReal = process.env.ANTHROPIC_API_KEY ? describe : describe.skip;

runReal("orchestrate — real Claude (live)", () => {
  it("generates a valid, model-resolvable pipeline for a free-form query", async () => {
    const planner = new AnthropicPlanner();
    const q = buildQuery({ text: "show me how many white cars passed in the last hour" });
    const { pipeline, plannerUsed } = await orchestrate(q, { planner });
    expect(plannerUsed).toBe("anthropic");
    expect(() => validatePipelineSpec(pipeline, defaultRegistry.modelIds)).not.toThrow();
  }, 30_000);
});
