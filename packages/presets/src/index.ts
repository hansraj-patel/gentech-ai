/**
 * @gentech/presets — module 07. Ready-made analytics presets that materialize
 * into the orchestrator's `PipelineSpec`, plus the continuous-stream machinery:
 * tumbling/sliding window aggregation, threshold-based alert rules, and a
 * long-running monitor lifecycle. Owned local types (PresetDefinition, AlertRule,
 * Monitor) live here; cross-module contracts come from @gentech/contracts.
 */
export {
  PRESETS,
  PresetCategory,
  PresetDefinitionSchema,
  fillTemplate,
  listPresets,
  getPreset,
  type PresetDefinition,
} from "./catalog.js";

export {
  AlertOp,
  AlertRuleSchema,
  evaluate,
  raiseAlert,
  type AlertRule,
  type AlertRaised,
  type RaiseAlertInput,
} from "./alerts.js";

export {
  WindowAggregator,
  WindowKind,
  type WindowAggregate,
  type WindowFlush,
  type WindowAggregatorOptions,
} from "./window.js";

export {
  materialize,
  type MaterializeContext,
} from "./materialize.js";

export {
  MonitorManager,
  type Monitor,
  type MonitorState,
  type DeployContext,
  type EmitFn,
} from "./monitor.js";
