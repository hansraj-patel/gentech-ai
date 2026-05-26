import type { CapabilityPlan, Planner, PlanInput } from "../plan.js";

/**
 * Deterministic, LLM-free fallback planner. It is NOT the primary path (the LLM is)
 * — it is the fail-safe the orchestrator falls back to when the LLM repeatedly emits
 * an invalid plan, so the agentic layer degrades to a sensible pipeline instead of
 * returning nothing. It covers the documented query shapes (counting, plate search).
 */
const COLORS = ["white", "black", "red", "blue", "green", "yellow", "silver", "grey", "gray"];
const VEHICLE_WORDS = ["car", "cars", "vehicle", "vehicles", "truck", "trucks", "bus", "buses"];

export class RuleBasedPlanner implements Planner {
  readonly name = "rule-based-fallback";

  async plan(input: PlanInput): Promise<CapabilityPlan> {
    const text = input.query.text.toLowerCase();
    const isPlateSearch = /\b(plate|number ?plate|licen[sc]e|anpr)\b/.test(text);
    const color = COLORS.find((c) => text.includes(c));
    const isVehicle = VEHICLE_WORDS.some((w) => text.includes(w));

    if (isPlateSearch) {
      const plate = extractPlate(input.query.text);
      return {
        rationale: "Plate search: detect vehicles, read plates, track over time, filter to the target.",
        nodes: [
          node("detect", "object_detection", { classes: ["car", "truck", "bus"] }, [], true),
          node("anpr", "anpr_ocr", {}, ["detect"], true),
          node("track", "tracking", {}, ["detect"], false),
          node("match", "match_filtering", plate ? { target: plate } : {}, ["anpr", "track"], false),
        ],
      };
    }

    // counting / "how many" (the default analytic shape)
    const nodes = [node("detect", "object_detection", { classes: isVehicle ? ["car"] : [] }, [], true)];
    let last = "detect";
    if (isVehicle) {
      nodes.push(node("classify", "vehicle_classification", {}, [last], true));
      last = "classify";
    }
    if (color) {
      nodes.push(node("color", "color_classification", { color }, [last], true));
      last = "color";
    }
    nodes.push(node("count", "counting", color ? { of: `${color} ${isVehicle ? "vehicles" : "objects"}` } : {}, [last], false));

    return { rationale: "Counting query: detect, refine attributes, then aggregate a count.", nodes };
  }
}

function node(
  nodeId: string,
  task: string,
  params: Record<string, unknown>,
  dependsOn: string[],
  parallelizable: boolean,
): CapabilityPlan["nodes"][number] {
  return { nodeId, task, params, dependsOn, parallelizable };
}

function extractPlate(text: string): string | undefined {
  const m = text.match(/\b([A-Z0-9]{4,8})\b/);
  return m?.[1];
}
