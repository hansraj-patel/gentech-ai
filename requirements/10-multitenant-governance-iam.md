# 10 — Multi-Tenant Governance & IAM

> Shared types: see [`00-shared-contracts.md`](./00-shared-contracts.md). Source lines: 386–404, 481–509.

## 1. Purpose
The authority for identity, tenant isolation, and authorization. Issues the `AuthContext` every request
carries, answers `authorize()` for every guarded action, and enforces compute governance (who may use how
much, at what priority). This is the backbone of "secure-by-default, multi-tenant."

## 2. In scope / Out of scope
**In:** authn integration; tenant model + isolation enforcement; RBAC + ABAC; scoped action permissions;
per-user/team compute quotas + priority rights; resolving `AuthContext` and `BudgetRef`.
**Out:** storing credentials (02); content/query safety (09); pricing math (11 — this module owns *limits*,
11 owns *cost*).

## 3. Inbound contracts
- `POST /authn` → issues a session resolving to an `AuthContext`.
- `POST /authorize` — body `{ AuthContext, action, resource }`. Returns `{ allow, reasons }`. Called by 02/05/06/09/04/07.
- `GET /governance/{tenantId}` — quotas, priority rights, isolation config.

## 4. Outbound contracts
- Provides `AuthContext` to all modules; supplies `priority` inputs to 05 and `BudgetRef` to 11.
- Emits `decision.logged` for authz decisions (audit) → 12.

## 5. Core data models (owned)
```jsonc
// AuthContext lives in shared §1 (this module is its authority)
Role { name:string, permissions: string[] }                       // RBAC
PolicyRule { effect:"allow"|"deny", action:string, resource:string, when?:{[attr:string]:string} } // ABAC
ComputeGovernance {
  tenantId: TenantId,
  perUserMaxConcurrentJobs: number,
  teamQuotas: { team:string, maxCredits:number }[],
  priorityRights: { role:string, maxPriority:number }[],
  isolation: { dedicatedGpuPool: boolean, perTenantQueue: boolean, namespace: string }
}
```

## 6. Module dependencies
**Upstream:** authn provider (adapter). **Downstream:** every module (authz), 05 (priority/isolation), 11 (budget linkage), 12 (audit).

## 7. Functional requirements
- **FR-1** Strong tenant isolation across **data, credentials, compute, logging, billing**. *(386–396)*
- **FR-2** Isolation strategies: namespace isolation, per-tenant queues, dedicated GPU pools, tenant-aware RBAC. *(398–404)*
- **FR-3** **RBAC + ABAC + policy-based authorization**: `authorize(action, resource)` evaluates roles, scopes, and attribute rules. *(503–508)*
- **FR-4** **Scoped action permissions**: allowed operations, analytics types, camera access, retention periods per user/role. *(494–501)*
- **FR-5** **Compute governance**: per-user limits, team-level quotas, role-based restrictions, priority-based execution rights — not every user gets unrestricted compute. *(481–491)*
- **FR-6** Supply the `priority` value and isolation requirements consumed by the scheduler (05).

## 8. Non-functional requirements
- `authorize()` p99 ≤ 30 ms (called on every guarded action); cacheable per (subject, action, resource).
- Default-deny: absence of an allow rule = deny.
- Cross-tenant access is structurally impossible, not just policy-blocked (tenant scoping in every query/key/queue).

## 9. v1: mock vs real
**Real** — auth, roles/ABAC, scoped permissions, governance limits, and `authorize()` are real (small,
security-critical). The authn provider may be a dev adapter; isolation may be logical (namespacing) rather
than physically dedicated pools in v1.

## 10. Open decisions
Authn provider (OIDC/SAML/custom); policy engine (OPA/Rego vs custom); physical vs logical tenant isolation per deployment; retention-policy enforcement mechanics.

## 11. Acceptance criteria
- A user without `query:run` scope is denied at `authorize()`; a permitted user passes.
- Tenant A cannot read tenant B's sources/results/logs/secrets (structural isolation test).
- A team over its credit quota or a user over concurrent-job limit is blocked / deprioritized at scheduling.
