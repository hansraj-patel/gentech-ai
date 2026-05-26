/**
 * Opaque, type-prefixed IDs (see requirements/00-shared-contracts.md §0).
 * Branded strings: treated as opaque, never parsed. The brand exists only at
 * compile time to stop a TenantId being passed where a NodeId is expected.
 */

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type TenantId = Brand<string, "TenantId">;
export type UserId = Brand<string, "UserId">;
export type SourceId = Brand<string, "SourceId">;
export type QueryId = Brand<string, "QueryId">;
export type PipelineId = Brand<string, "PipelineId">;
export type NodeId = Brand<string, "NodeId">;
export type ModelId = Brand<string, "ModelId">;
export type BudgetRef = Brand<string, "BudgetRef">;

const PREFIX = {
  TenantId: "ten_",
  UserId: "usr_",
  SourceId: "src_",
  QueryId: "query_",
  PipelineId: "pipe_",
  NodeId: "node_",
  BudgetRef: "bud_",
} as const;

let counter = 0;
/** Deterministic-ish id generator; pass a seed for reproducible ids in tests. */
export function makeId<K extends keyof typeof PREFIX>(kind: K, seed?: string): string {
  const suffix = seed ?? (++counter).toString(36).padStart(4, "0");
  return `${PREFIX[kind]}${suffix}`;
}
