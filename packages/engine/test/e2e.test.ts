import { describe, it, expect } from "vitest";
import type { AuthContext } from "@gentech/contracts";
import { buildQuery, orchestrate, RuleBasedPlanner } from "@gentech/orchestrator";
import { MockBackend, getScenario, mockSegments } from "@gentech/mock-server";
import { PipelineEngine, InMemoryEventSink } from "../dist/index.js";

/**
 * The headline acceptance criterion: the REAL agentic layer plans a pipeline from
 * natural language, the REAL engine runs it against the mock backend, and the
 * "how many white cars" query returns the scenario's intended count (4),
 * reproducibly under a fixed seed.
 */
async function runWhiteCars() {
  const scenario = getScenario("parking_lot_daytime");
  const query = buildQuery({
    text: "How many white cars are in the parking lot?",
    sources: [scenario.sources[0]!.sourceId],
    tenantId: "ten_demo",
  });
  const { pipeline } = await orchestrate(query, { planner: new RuleBasedPlanner() });

  const backend = new MockBackend({ scenarioId: "parking_lot_daytime", seed: "fixed" });
  const auth: AuthContext = { tenantId: "ten_demo", userId: "usr_demo", roles: ["analyst"], scopes: [], attrs: {} };
  const engine = new PipelineEngine();
  const sink = new InMemoryEventSink();
  return engine.run(pipeline, mockSegments(scenario, "ten_demo"), auth, {
    inference: backend,
    compute: backend,
    sink,
  });
}

describe("e2e: orchestrator → engine → mock", () => {
  it("counts exactly 4 white cars and succeeds", async () => {
    const { job, results, usage } = await runWhiteCars();
    const final = results.at(-1)!;
    expect(final.kind).toBe("count");
    expect((final.payload as { count: number }).count).toBe(4);
    expect((final.payload as { color: string }).color).toBe("white");
    expect(final.partial).toBe(false);
    expect(job.state).toBe("succeeded");
    expect(usage.length).toBeGreaterThan(0);
  });

  it("is reproducible under a fixed seed", async () => {
    const a = await runWhiteCars();
    const b = await runWhiteCars();
    expect((a.results.at(-1)!.payload as { count: number }).count).toBe(
      (b.results.at(-1)!.payload as { count: number }).count,
    );
  });

  it("plate search returns a match for the target plate", async () => {
    const scenario = getScenario("gate_intrusion_night");
    const query = buildQuery({
      text: "Find license plate ABC1234 at the gate",
      sources: [scenario.sources[0]!.sourceId],
      tenantId: "ten_demo",
    });
    const { pipeline } = await orchestrate(query, { planner: new RuleBasedPlanner() });
    const backend = new MockBackend({ scenarioId: "gate_intrusion_night", seed: "fixed" });
    const auth: AuthContext = { tenantId: "ten_demo", userId: "usr_demo", roles: ["analyst"], scopes: [], attrs: {} };
    const { results } = await new PipelineEngine().run(pipeline, mockSegments(scenario, "ten_demo"), auth, {
      inference: backend,
      compute: backend,
    });
    const final = results.at(-1)!;
    expect(final.kind).toBe("match");
    expect((final.payload as { matched: boolean }).matched).toBe(true);
  });
});
