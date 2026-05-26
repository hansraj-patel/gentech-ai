/**
 * End-to-end demo (run via `pnpm --filter @gentech/engine demo`): the REAL agentic
 * layer (orchestrator) plans a pipeline from a natural-language query, and the REAL
 * engine executes it against the mock backend — proving the v1 "intelligence is
 * real, pixels are faked" boundary. No API key needed: uses the rule-based planner.
 */
import type { AuthContext } from "@gentech/contracts";
import { buildQuery, orchestrate, RuleBasedPlanner } from "@gentech/orchestrator";
import { CATALOG } from "@gentech/model-registry";
import { MockBackend, getScenario, mockSegments } from "@gentech/mock-server";
import { InMemoryEventSink, PipelineEngine } from "./index.js";

const QUERY = process.argv[2] ?? "How many white cars are in the parking lot?";
const SCENARIO = process.env.SCENARIO ?? "parking_lot_daytime";
const SEED = process.env.SEED ?? "demo";

async function main() {
  const scenario = getScenario(SCENARIO);
  const sourceId = scenario.sources[0]!.sourceId;

  // ── 1. real orchestration: NL → PipelineSpec ────────────────────────────────
  const query = buildQuery({ text: QUERY, sources: [sourceId], tenantId: "ten_demo" });
  const { pipeline, cost, plannerUsed } = await orchestrate(query, { planner: new RuleBasedPlanner() });

  console.log(`\n🧠  Query: "${QUERY}"`);
  console.log(`    planner=${plannerUsed}  est=${cost.credits} credits (${cost.confidence})`);
  console.log(`    pipeline ${pipeline.pipelineId}:`);
  for (const n of pipeline.nodes) {
    const deps = pipeline.edges.filter((e) => e.to === n.nodeId).map((e) => e.from);
    console.log(`      • ${n.nodeId} [${n.task}] model=${n.modelId} ${deps.length ? `← ${deps.join(",")}` : "(root)"}`);
  }

  // ── 2. real execution against the mock backend ──────────────────────────────
  const latency = new Map(CATALOG.map((m) => [m.modelId, m.latencyMsEst]));
  const backend = new MockBackend({ scenarioId: SCENARIO, seed: SEED, latencyLookup: (id) => latency.get(id) });
  const segments = mockSegments(scenario, "ten_demo");
  const auth: AuthContext = { tenantId: "ten_demo", userId: "usr_demo", roles: ["analyst"], scopes: [], attrs: {} };
  const sink = new InMemoryEventSink();

  const engine = new PipelineEngine();
  const { job, results, usage } = await engine.run(pipeline, segments, auth, { inference: backend, compute: backend, sink });

  // ── 3. show the DAG progressing + the final result ──────────────────────────
  console.log(`\n📹  ${segments.length} segments → executing DAG…`);
  for (const e of sink.byTopic("job.status.changed")) {
    const s = e.payload as { state: string; progress: number };
    console.log(`    job ${s.state.padEnd(9)} progress=${(s.progress * 100).toFixed(0)}%`);
  }
  const partials = results.filter((r) => r.partial).length;
  console.log(`\n📊  ${results.length} result events (${partials} partial) — final:`);
  console.log("   ", JSON.stringify(results.at(-1)?.payload));
  console.log(`\n💸  ${usage.length} usage events  |  job ${job.state}  cost=${job.costSoFar} credits`);
  console.log(`    dlq=${sink.byTopic("dlq.failed").length}  spans=${sink.byTopic("trace.span").length}\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
