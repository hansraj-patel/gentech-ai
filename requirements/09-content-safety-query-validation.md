# 09 — Content Safety & Query Validation

> Shared types: see [`00-shared-contracts.md`](./00-shared-contracts.md). Source lines: 352–384.

## 1. Purpose
The safety gate. Two jobs: (a) **validate every NL query** before orchestration against allowed
capabilities, tenant permissions, safety boundaries, and compliance constraints; (b) **detect and filter
unsafe visual content** (NSFW/restricted categories) in processed media. Validation logic is real in v1;
pixel-level scoring is mocked.

## 2. In scope / Out of scope
**In:** query validation policy + verdicts; content-safety classification of media; policy enforcement
(block/allow/redact); compliance-constraint checks.
**Out:** authn/role definitions (10 — this module *consumes* `AuthContext`); running pipelines (04);
deciding pricing (11).

## 3. Inbound contracts
- `POST /validate-query` — body `{ Query, AuthContext }`. Returns `ValidationVerdict`. Sits between 08 and 03 on `query.submitted`.
- `POST /scan-content` — body `{ segmentRef, modelId }` (or consumes inference `nsfwScore`). Returns `SafetyVerdict`.

## 4. Outbound contracts
- On pass, forwards `query.submitted` to 03; on block, returns reason to 08 (shown as the chat "safety ✗").
- Calls 10 `authorize()` for capability/permission checks; calls 06/13 for NSFW model scoring.
- Emits `decision.logged` (every verdict, for audit/compliance) → 12.

## 5. Core data models (owned)
```jsonc
ValidationVerdict {
  queryId: QueryId, allow: boolean,
  reasons: { code:string, message:string }[],   // e.g. CAPABILITY_NOT_ALLOWED, COMPLIANCE_RESTRICTED
  requiredScopesMissing?: string[],
  redactions?: string[]                          // capabilities allowed only in redacted form
}
SafetyVerdict { segmentId: SegmentId, category:"safe"|"nsfw"|"restricted", score:number, action:"allow"|"blur"|"block" }
SafetyPolicy { tenantId: TenantId, blockedCategories: string[], restrictedCapabilities: string[] }
```

## 6. Module dependencies
**Upstream:** 10 (authz/permissions), 06/13 (NSFW model). **Downstream:** 03 (gated), 08 (block reasons), 12 (audit).

## 7. Functional requirements
- **FR-1** Validate NL queries against **allowed capabilities, tenant permissions, safety boundaries, compliance constraints**; return a structured verdict. *(370–377)*
- **FR-2** Block unauthorized surveillance requests and restrict sensitive identification operations per policy. *(379–383)*
- **FR-3** Detect & filter **adult/unsafe/restricted visual categories** via NSFW/moderation classifiers. *(354–366)*
- **FR-4** Enforcement actions: allow / blur(redact) / block — applied as a policy-enforcement step in the pipeline. *(366)*
- **FR-5** Per-tenant `SafetyPolicy`; compliance constraints (e.g. restricted biometric ID) are configurable.
- **FR-6** Every verdict is logged with `traceId` for auditability and compliance review.

## 8. Non-functional requirements
- Query validation p95 ≤ 300 ms (it's inline before orchestration in the chat).
- Fail-closed: if the validator is unavailable, queries are blocked, not passed.
- No false "allow" for blocked categories (precision-prioritized on the block side).

## 9. v1: mock vs real
**Real:** query-validation logic, capability/permission/compliance checks, policy enforcement decisions,
audit logging. **Mocked:** pixel-level NSFW/moderation scores come from module 13 (the `nsfwScore` in
`InferenceResponse`); the decision logic acting on those scores is real.

## 10. Open decisions
Policy language (OPA/Rego vs custom); capability ontology shared with 03; moderation model when real; compliance frameworks per region.

## 11. Acceptance criteria
- A query requesting a restricted identification op returns `allow:false` with a clear reason; an allowed query passes through to 03.
- A segment with a high (mocked) `nsfwScore` yields `action:"blur"|"block"` and is enforced downstream.
- Validator outage blocks queries (fail-closed), verifiable by disabling the mock scorer.
