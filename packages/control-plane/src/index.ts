/**
 * @gentech/control-plane (module 12) — the in-process event bus, telemetry
 * recorder, health/circuit registry, and HTTP/SSE gateway that tie the
 * platform together. The gateway's run path is injected so WP-E can plug in
 * the real orchestrate+engine host without this package depending on it.
 */
export {
  InProcessEventBus,
  type BusHandler,
  type Unsubscribe,
  type ReplayFilter,
} from "./bus.js";
export { Recorder } from "./recorder.js";
export { HealthRegistry } from "./health.js";
export { Gateway, type GatewayOptions, type SubmitFn } from "./gateway.js";
export {
  createHost,
  createGatewayHost,
  UI_SPEC_TOPIC,
  type Host,
  type GatewayHost,
  type HostOptions,
  type SubmitInput,
  type SubmitOutput,
} from "./host.js";
