import { makeId, QuerySchema, type Query } from "@gentech/contracts";

/** Convenience builder so callers (CLI, UI, tests) construct a valid Query easily. */
export function buildQuery(input: {
  text: string;
  tenantId?: string;
  sources?: string[];
  constraints?: Query["constraints"];
}): Query {
  return QuerySchema.parse({
    queryId: makeId("QueryId"),
    tenantId: input.tenantId ?? makeId("TenantId", "dev"),
    text: input.text,
    sources: input.sources ?? [makeId("SourceId", "demo")],
    constraints: input.constraints,
  });
}
