# 02 — Credential & Secrets Vault

> Shared types: see [`00-shared-contracts.md`](./00-shared-contracts.md). Source lines: 57–77.

## 1. Purpose
Guarantee that camera credentials and stream access information are **never stored directly**. This module
is the only component that ever holds raw credential material; everyone else holds an opaque `SecretRef`
and resolves it to a short-lived `EphemeralCredential` at runtime, with strict tenant isolation.

## 2. In scope / Out of scope
**In:** ingest + hash/tokenize credentials; store ciphertext in a secrets-manager backend; runtime
encrypted retrieval; issue temporary, expiring credentials; per-tenant key isolation; rotation.
**Out:** using credentials to connect (01); deciding who may access a secret (policy comes from 10; this
module enforces the decision); long-term analytic data storage.

## 3. Inbound contracts
- `POST /secrets` — store a credential. Body: tenant + credential material + metadata. Returns `SecretRef` (never echoes the secret).
- `POST /secrets/resolve` — body `{ SecretRef, AuthContext }`. Returns `EphemeralCredential` (short TTL) iff `AuthContext` is authorized (checks with module 10) and tenant matches.
- `POST /secrets/{id}/rotate` — rotate underlying material; `SecretRef` stays stable.
- `DELETE /secrets/{id}` — revoke.

## 4. Outbound contracts
- Calls module 10 `authorize(AuthContext, "secret:resolve", secretId)`.
- Emits `decision.logged` + `trace.span` (module 12) for every resolve/rotate/revoke (audit).

## 5. Core data models (owned)
`SecretRef`, `EphemeralCredential` — shared contracts §3.

## 6. Module dependencies
**Upstream:** 10 (authz). **Downstream:** 01 (resolves creds), 12 (audit). Backend secrets manager via adapter.

## 7. Functional requirements
- **FR-1** Credentials are **hashed and tokenized**; the returned `SecretRef` reveals nothing about the value. *(63–66)*
- **FR-2** Store ciphertext in a pluggable secrets manager (Vault / AWS SM / GCP SM / Azure KV). *(71–77)*
- **FR-3** Resolution returns **encrypted-at-rest, decrypted-in-transit, short-TTL** credentials; callers must discard at `expiresAt`. *(67–68)*
- **FR-4** Prefer **temporary credential access** (lease/STS-style) over long-lived secrets wherever the backend supports it. *(68)*
- **FR-5** **Tenant-isolated** access: a resolve for tenant A can never return tenant B's secret, even with a forged `SecretRef`. *(69)*
- **FR-6** Support rotation without changing the `SecretRef` held by other modules.

## 8. Non-functional requirements
- Resolve latency p99 ≤ 50 ms (it's on the live-connect hot path).
- Per-tenant encryption keys; key compromise is blast-radius-limited to one tenant.
- Every resolve is audit-logged with `traceId`; raw values never logged.

## 9. v1: mock vs real
**Real** — this module is fully real in v1 (it's small and security-critical). The backend secrets manager
may be a local/dev adapter, but the hash/tokenize/resolve/rotate logic and tenant isolation are real.

## 10. Open decisions
Backend choice (Vault vs cloud-native); temporary-credential mechanism per backend; KMS for envelope encryption; rotation cadence policy.

## 11. Acceptance criteria
- Storing a credential returns a `SecretRef`; the value never appears in any response, log, or trace.
- A resolve with a mismatched-tenant `AuthContext` is denied.
- Rotating a secret leaves existing `SecretRef`s valid and resolving to the new value.
