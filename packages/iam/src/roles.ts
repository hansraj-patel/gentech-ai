import type { Role } from "./types.js";

/** Seed RBAC catalog. Real deployments load these per tenant; these are the defaults. */
export const ROLES: Record<string, Role> = {
  viewer: { name: "viewer", permissions: ["analytics:read:*"] },
  analyst: { name: "analyst", permissions: ["query:run", "analytics:*", "camera:read:*"] },
  operator: {
    name: "operator",
    permissions: ["query:run", "analytics:*", "camera:read:*", "camera:write:*", "pipeline:deploy"],
  },
  tenant_admin: { name: "tenant_admin", permissions: ["*"] },
};

/**
 * True if colon-delimited `pattern` covers `target`. `*` is a single-segment
 * wildcard; a trailing `*` also covers deeper targets (`a:b:*` ⊇ `a:b:c:d`); a
 * lone `*` covers everything.
 */
export function matchScope(pattern: string, target: string): boolean {
  if (pattern === target || pattern === "*") return true;
  const pp = pattern.split(":");
  const tp = target.split(":");
  const wildcardTail = pp[pp.length - 1] === "*";
  if (!wildcardTail && pp.length !== tp.length) return false;
  if (wildcardTail && tp.length < pp.length - 1) return false;
  for (let i = 0; i < pp.length; i++) {
    const seg = pp[i];
    if (seg === "*") {
      if (i === pp.length - 1) return true; // trailing wildcard consumes the rest
      continue; // single-segment wildcard
    }
    if (seg !== tp[i]) return false;
  }
  return true;
}
