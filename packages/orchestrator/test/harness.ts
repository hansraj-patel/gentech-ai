/** Single import surface for orchestrator tests: built package + its deps. */
export {
  orchestrate,
  buildQuery,
  RuleBasedPlanner,
  type CapabilityPlan,
  type Planner,
  type PlanInput,
} from "../dist/index.js";
export { validatePipelineSpec } from "@gentech/contracts";
export { defaultRegistry } from "@gentech/model-registry";
