/**
 * Ports — the hexagonal seams that let the engine run against the mock server today
 * and a real backend later with zero core changes. The engine core depends only on
 * these interfaces (+ shared contracts), never on a concrete backend. The mock
 * server's `MockBackend` is structurally compatible with `InferenceClient` +
 * `ComputeClient`; a real module 06/05 client implements the same shapes.
 */
import type {
  ComputeRequest,
  Event,
  GpuInventory,
  InferenceRequest,
  InferenceResponse,
} from "@gentech/contracts";

/** Stands in for module 06 (or the mock): run one node's inference on one segment. */
export interface InferenceClient {
  infer(req: InferenceRequest): Promise<InferenceResponse>;
}

export interface LeaseDecision {
  grantable: boolean;
  gpuClass: string;
  endpoint?: string;
  reason?: string;
}

/** Stands in for module 05's physical layer (or the mock): inventory + lease grants. */
export interface ComputeClient {
  inventory(): Promise<GpuInventory>;
  leaseFeasibility(req: ComputeRequest): Promise<LeaseDecision>;
}

/** Abstract event bus seam (module 12 owns the real bus). */
export interface EventSink {
  emit(topic: string, event: Event): void;
}

/** Default in-process sink: records everything for tests/CLI inspection. */
export class InMemoryEventSink implements EventSink {
  readonly events: { topic: string; event: Event }[] = [];

  emit(topic: string, event: Event): void {
    this.events.push({ topic, event });
  }

  byTopic(topic: string): Event[] {
    return this.events.filter((e) => e.topic === topic).map((e) => e.event);
  }
}

export interface EngineClients {
  inference: InferenceClient;
  compute: ComputeClient;
  sink?: EventSink;
}
