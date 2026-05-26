import { makeId, type AuthContext } from "@gentech/contracts";

/** Pluggable authn boundary. Real impls validate a session token against an IdP. */
export interface AuthnProvider {
  resolve(overrides?: Partial<AuthContext>): AuthContext;
}

/** Dev provider — issues a fixed, deterministic AuthContext with no network call. */
export class DevAuthnProvider implements AuthnProvider {
  resolve(overrides: Partial<AuthContext> = {}): AuthContext {
    return {
      tenantId: makeId("TenantId", "dev"),
      userId: makeId("UserId", "dev"),
      roles: ["analyst"],
      scopes: ["query:run"],
      attrs: {},
      ...overrides,
    };
  }
}

const devProvider = new DevAuthnProvider();

/** Real replacement for the orchestrator's `resolveAuth` stub (module 10). */
export function resolveAuth(overrides?: Partial<AuthContext>): AuthContext {
  return devProvider.resolve(overrides);
}
