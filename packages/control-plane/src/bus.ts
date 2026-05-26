/**
 * In-process event bus (module 12). A synchronous pub/sub fan-out that is a
 * drop-in for the engine's `EventSink` — so the engine, orchestrator and the
 * gateway can all share one bus. Every emitted event is buffered so late
 * subscribers (and the `Recorder`/gateway replay endpoints) can reconstruct
 * history. Wildcard (`"*"`) subscribers see every topic.
 */
import type { Event, TopicName } from "@gentech/contracts";
import type { EventSink } from "@gentech/engine";

/** A handler is invoked synchronously with the topic and the event envelope. */
export type BusHandler = (event: Event, topic: string) => void;

/** Unsubscribe by calling the function returned from `subscribe`. */
export type Unsubscribe = () => void;

/** Optional filter for `replay` — narrows the buffered history. */
export interface ReplayFilter {
  topic?: TopicName | string;
  tenantId?: string;
  traceId?: string;
  jobId?: string;
}

interface BufferedEvent {
  topic: string;
  event: Event;
}

/**
 * Synchronous in-process bus. `emit` is the `EventSink` seam the engine writes
 * to; handlers run inline (no microtask hop) so tests observe events
 * deterministically. A throwing handler never blocks other handlers.
 */
export class InProcessEventBus implements EventSink {
  private readonly buffer: BufferedEvent[] = [];
  private readonly byTopic = new Map<string, Set<BusHandler>>();
  private readonly wildcard = new Set<BusHandler>();

  /** EventSink: publish `event` on `topic`, buffer it, fan out to subscribers. */
  emit(topic: string, event: Event): void {
    this.buffer.push({ topic, event });
    const exact = this.byTopic.get(topic);
    if (exact) for (const h of [...exact]) safeCall(h, event, topic);
    for (const h of [...this.wildcard]) safeCall(h, event, topic);
  }

  /** Subscribe to one topic or `"*"` (all). Returns an idempotent unsubscribe. */
  subscribe(topic: TopicName | "*" | string, handler: BusHandler): Unsubscribe {
    const set = topic === "*" ? this.wildcard : this.topicSet(topic);
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /** Return buffered events (optionally filtered), in emission order. */
  replay(filter: ReplayFilter = {}): Event[] {
    return this.buffer
      .filter(({ topic, event }) => {
        if (filter.topic !== undefined && topic !== filter.topic) return false;
        if (filter.tenantId !== undefined && event.tenantId !== filter.tenantId) return false;
        if (filter.traceId !== undefined && event.traceId !== filter.traceId) return false;
        if (filter.jobId !== undefined && event.jobId !== filter.jobId) return false;
        return true;
      })
      .map(({ event }) => event);
  }

  private topicSet(topic: string): Set<BusHandler> {
    let set = this.byTopic.get(topic);
    if (!set) {
      set = new Set();
      this.byTopic.set(topic, set);
    }
    return set;
  }
}

function safeCall(handler: BusHandler, event: Event, topic: string): void {
  try {
    handler(event, topic);
  } catch {
    // A misbehaving subscriber must not break the fan-out for the others.
  }
}
