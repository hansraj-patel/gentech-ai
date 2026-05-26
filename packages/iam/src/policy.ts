import type { AuthContext } from "@gentech/contracts";
import { ROLES, matchScope } from "./roles.js";
import type { AuthDecision, PolicyRule } from "./types.js";

/** Effective scopes = explicit AuthContext.scopes ∪ scopes granted by the user's roles. */
export function effectiveScopes(auth: AuthContext): string[] {
  const fromRoles = auth.roles.flatMap((r) => ROLES[r]?.permissions ?? []);
  return [...new Set([...auth.scopes, ...fromRoles])];
}

function ruleMatches(
  rule: PolicyRule,
  action: string,
  resource: string,
  attrs: Record<string, string>,
): boolean {
  if (!matchScope(rule.action, action)) return false;
  if (!matchScope(rule.resource, resource)) return false;
  if (rule.when) {
    for (const [k, v] of Object.entries(rule.when)) {
      if (attrs[k] !== v) return false;
    }
  }
  return true;
}

/**
 * RBAC ∪ ABAC authorization. Explicit `deny` rules always win; an explicit
 * `allow` rule grants; otherwise a matching role/scope grant allows; absence of
 * any grant is default-deny. Pure and deterministic.
 */
export function authorize(
  auth: AuthContext,
  action: string,
  resource = "*",
  rules: PolicyRule[] = [],
): AuthDecision {
  // explicit deny wins over everything
  for (const rule of rules) {
    if (rule.effect === "deny" && ruleMatches(rule, action, resource, auth.attrs)) {
      return { allow: false, reason: `denied by policy ${rule.action}:${rule.resource}` };
    }
  }
  // explicit allow rule
  for (const rule of rules) {
    if (rule.effect === "allow" && ruleMatches(rule, action, resource, auth.attrs)) {
      return { allow: true };
    }
  }
  // RBAC / scope grant
  const requested = resource === "*" ? action : `${action}:${resource}`;
  if (effectiveScopes(auth).some((s) => matchScope(s, requested))) return { allow: true };
  return { allow: false, reason: `no grant for ${requested}` };
}
