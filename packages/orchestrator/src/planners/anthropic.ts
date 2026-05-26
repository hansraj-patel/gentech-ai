import Anthropic from "@anthropic-ai/sdk";
import { ContractError } from "@gentech/contracts";
import type { CapabilityPlan, Planner, PlanInput } from "../plan.js";
import { CAPABILITY_TASKS, ontologySummary } from "../ontology.js";

const PLAN_TOOL = {
  name: "emit_capability_plan",
  description:
    "Emit the capability-level processing DAG for the user's video-analytics query. " +
    "Choose ONLY tasks from the allowed ontology. Express dependencies via dependsOn. " +
    "Do NOT pick models — that happens downstream. The graph MUST be acyclic.",
  input_schema: {
    type: "object" as const,
    properties: {
      nodes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            nodeId: { type: "string", description: "unique short id, e.g. 'detect'" },
            task: { type: "string", enum: CAPABILITY_TASKS },
            params: { type: "object", description: "task params, e.g. {classes:['car'], color:'white'}" },
            parallelizable: { type: "boolean", description: "can this fan out across segments?" },
            dependsOn: { type: "array", items: { type: "string" }, description: "upstream nodeIds" },
          },
          required: ["nodeId", "task", "dependsOn"],
        },
      },
      rationale: { type: "string", description: "one sentence: why this pipeline" },
    },
    required: ["nodes", "rationale"],
  },
};

export interface AnthropicPlannerOptions {
  model?: string;
  apiKey?: string;
  maxTokens?: number;
}

/**
 * Primary planner: Claude with forced tool-use emits the capability DAG.
 * temperature:0 for reproducibility (NFR). The model only plans capabilities +
 * topology; the deterministic resolver picks concrete models afterward.
 */
export class AnthropicPlanner implements Planner {
  readonly name = "anthropic";
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly maxTokens: number;

  constructor(opts: AnthropicPlannerOptions = {}) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new ContractError({
        code: "ORCHESTRATOR_MISCONFIGURED",
        module: "orchestrator",
        message: "ANTHROPIC_API_KEY not set; provide apiKey or use a different planner",
        retryable: false,
      });
    }
    this.client = new Anthropic({ apiKey });
    this.model = opts.model ?? "claude-sonnet-4-6";
    this.maxTokens = opts.maxTokens ?? 1024;
  }

  async plan(input: PlanInput): Promise<CapabilityPlan> {
    const constraints = input.query.constraints ?? {};
    const userText =
      `Query: "${input.query.text}"\n` +
      `Sources: ${input.query.sources.length}\n` +
      `Constraints: ${JSON.stringify(constraints)}\n` +
      (input.repairFeedback
        ? `\nYour previous plan was REJECTED for these reasons; fix them:\n${input.repairFeedback}`
        : "");

    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      temperature: 0,
      system:
        "You are the pipeline orchestrator for a video-intelligence platform. " +
        "Map the user's natural-language objective to a minimal capability DAG using ONLY these capabilities:\n" +
        ontologySummary() +
        "\nAlways call emit_capability_plan. Keep the graph small and acyclic; mark per-segment work parallelizable.",
      tools: [PLAN_TOOL],
      tool_choice: { type: "tool", name: PLAN_TOOL.name },
      messages: [{ role: "user", content: userText }],
    });

    const toolUse = res.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") {
      throw new ContractError({
        code: "PLAN_INVALID",
        module: "orchestrator",
        message: "model did not return a tool_use block",
        retryable: true,
      });
    }
    return toolUse.input as CapabilityPlan;
  }
}
