/**
 * Tiny demo CLI:  pnpm orchestrate "how many white cars?" --source src_demo
 * Uses Claude if ANTHROPIC_API_KEY is set, else the deterministic rules planner,
 * so it runs offline out of the box. Prints the resolved DAG + cost estimate.
 */
import { ContractError } from "@gentech/contracts";
import { orchestrate } from "./orchestrate.js";
import { buildQuery } from "./query.js";
import { compressionPlan } from "./compression.js";
import { AnthropicPlanner } from "./planners/anthropic.js";
import { RuleBasedPlanner } from "./planners/rules.js";
import type { Planner } from "./plan.js";

interface Args {
  text: string;
  sources: string[];
  maxCredits?: number;
  minQuality?: "low" | "standard" | "high";
  forceRules: boolean;
}

function parseArgs(argv: string[]): Args {
  const text: string[] = [];
  const sources: string[] = [];
  let maxCredits: number | undefined;
  let minQuality: Args["minQuality"];
  let forceRules = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--source") sources.push(argv[++i]!);
    else if (a === "--max-credits") maxCredits = Number(argv[++i]);
    else if (a === "--min-quality") minQuality = argv[++i] as Args["minQuality"];
    else if (a === "--rules") forceRules = true;
    else text.push(a);
  }
  return { text: text.join(" "), sources, maxCredits, minQuality, forceRules };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.text) {
    console.error('usage: orchestrate "<query>" [--source id] [--max-credits n] [--min-quality low|standard|high] [--rules]');
    process.exit(2);
  }

  const query = buildQuery({
    text: args.text,
    sources: args.sources.length ? args.sources : undefined,
    constraints:
      args.maxCredits !== undefined || args.minQuality
        ? { maxCredits: args.maxCredits, minQuality: args.minQuality }
        : undefined,
  });

  const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
  const planner: Planner =
    args.forceRules || !hasKey ? new RuleBasedPlanner() : new AnthropicPlanner();
  if (!hasKey && !args.forceRules) {
    console.error("(no ANTHROPIC_API_KEY — using deterministic rules planner)\n");
  }

  try {
    const { pipeline, cost, degraded, plannerUsed } = await orchestrate(query, { planner });

    console.log(`Query:    ${query.text}`);
    console.log(`Planner:  ${plannerUsed}${degraded ? "  (degraded to fit budget)" : ""}`);
    console.log(`\nPipeline (${pipeline.nodes.length} nodes):`);
    for (const n of pipeline.nodes) {
      const deps = pipeline.edges.filter((e) => e.to === n.nodeId).map((e) => e.from);
      const after = deps.length ? `  ⟵ ${deps.join(", ")}` : "  (root)";
      console.log(`  • ${n.nodeId}: ${n.task} → ${n.modelId} [${n.compute.gpuClass}]${after}`);
    }
    console.log(`\nCost:     ${cost.credits} credits  |  ~${cost.runtimeSecEst}s  |  gpu=${cost.gpuClassEst}  |  confidence=${cost.confidence}`);
    for (const b of cost.breakdown) console.log(`            - ${b.item}: ${b.credits}`);
    const cp = compressionPlan(query);
    console.log(`\nUpload compression: ${cp.targetResolution} @ ${cp.targetBitrateKbps}kbps/${cp.targetFps}fps — ${cp.rationale}`);
  } catch (err) {
    if (err instanceof ContractError) {
      console.error(`\n✗ ${err.code}: ${err.message}`);
      if (err.details) console.error(JSON.stringify(err.details, null, 2));
      process.exit(1);
    }
    throw err;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
