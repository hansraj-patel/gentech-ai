import { makeId, type AuthContext, type Query } from "@gentech/contracts";

/**
 * Stubs for modules this build does not yet implement (09 validation, 10 IAM,
 * 12 event bus). They satisfy the contracts so the orchestrator runs end-to-end;
 * each is replaced by the real module later without touching orchestrator code.
 */

/** Module 09 stub — always allows. The real validator gates capabilities/safety. */
export interface ValidationVerdict {
  allow: boolean;
  reasons: { code: string; message: string }[];
}
export function validateQuery(_query: Query, _auth: AuthContext): ValidationVerdict {
  return { allow: true, reasons: [] };
}

/** Module 10 stub — a fixed dev AuthContext + a default execution priority. */
export function resolveAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    tenantId: makeId("TenantId", "dev"),
    userId: makeId("UserId", "dev"),
    roles: ["analyst"],
    scopes: ["query:run"],
    attrs: {},
    ...overrides,
  };
}
export function priorityFor(_auth: AuthContext): number {
  return 5; // mid priority; real governance (module 10) derives this from role/quota
}

/** Module 12 stub — an in-process event bus that records what was published. */
export interface BusEvent {
  type: string;
  tenantId: string;
  traceId: string;
  payload: unknown;
}
export class InProcessEventBus {
  readonly published: BusEvent[] = [];
  publish(event: BusEvent): void {
    this.published.push(event);
  }
}
