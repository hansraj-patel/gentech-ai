import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import type { AuthContext, ComputeRequest, GpuInventory, InferenceRequest, InferenceResponse } from "@gentech/contracts";
import { buildQuery, orchestrate, RuleBasedPlanner } from "@gentech/orchestrator";
import { MockBackend, createMockServer, getScenario, mockSegments } from "@gentech/mock-server";
import { PipelineEngine, type ComputeClient, type InferenceClient, type LeaseDecision } from "../dist/index.js";

/**
 * Module 13's headline guarantee: swapping the mock's transport from in-process to
 * an HTTP endpoint requires ZERO engine changes and yields the same answer — proof
 * that the mock is contract-faithful and that going live later is a URL change.
 */
let server: Server;
let base: string;

beforeAll(async () => {
  server = createMockServer(new MockBackend({ scenarioId: "parking_lot_daytime", seed: "fixed" }));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const httpInference: InferenceClient = {
  async infer(req: InferenceRequest): Promise<InferenceResponse> {
    const r = await fetch(`${base}/infer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    return (await r.json()) as InferenceResponse;
  },
};

const httpCompute: ComputeClient = {
  async inventory(): Promise<GpuInventory> {
    return (await (await fetch(`${base}/compute/inventory`)).json()) as GpuInventory;
  },
  async leaseFeasibility(req: ComputeRequest): Promise<LeaseDecision> {
    const r = await fetch(`${base}/compute/lease-feasibility`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    return (await r.json()) as LeaseDecision;
  },
};

describe("swap-in: engine over HTTP mock", () => {
  it("white-car count is identical whether the mock is in-process or HTTP", async () => {
    const scenario = getScenario("parking_lot_daytime");
    const query = buildQuery({
      text: "How many white cars are in the parking lot?",
      sources: [scenario.sources[0]!.sourceId],
      tenantId: "ten_demo",
    });
    const { pipeline } = await orchestrate(query, { planner: new RuleBasedPlanner() });
    const auth: AuthContext = { tenantId: "ten_demo", userId: "usr_demo", roles: ["analyst"], scopes: [], attrs: {} };

    const { job, results } = await new PipelineEngine().run(pipeline, mockSegments(scenario, "ten_demo"), auth, {
      inference: httpInference,
      compute: httpCompute,
    });

    expect(job.state).toBe("succeeded");
    expect((results.at(-1)!.payload as { count: number }).count).toBe(4);
  });
});
