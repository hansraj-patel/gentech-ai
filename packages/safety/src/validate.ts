import type { AuthContext, Query } from "@gentech/contracts";
import { authorize as iamAuthorize } from "@gentech/iam";
import { defaultSafetyPolicy } from "./policy.js";
import type { SafetyPolicy, ValidationVerdict } from "./types.js";

export type AuthorizeFn = (
  auth: AuthContext,
  action: string,
  resource?: string,
) => { allow: boolean; reason?: string };

export interface ValidateOptions {
  policy?: SafetyPolicy;
  /** Injectable for testing; defaults to @gentech/iam's authorize. */
  authorize?: AuthorizeFn;
}

/**
 * Module 09 gate — may this query run for this principal? Checks, in order:
 *  (a) holds `query:run` scope (via IAM authorize),
 *  (b) does not request a restricted capability (privacy),
 *  (c) does not reference a blocked category.
 * Pure + deterministic. Runs BEFORE orchestration, so it never touches the
 * execution plane.
 */
export function validateQuery(
  query: Query,
  auth: AuthContext,
  opts: ValidateOptions = {},
): ValidationVerdict {
  const policy = opts.policy ?? defaultSafetyPolicy(auth.tenantId);
  const authorize = opts.authorize ?? iamAuthorize;
  const reasons: { code: string; message: string }[] = [];
  const requiredScopesMissing: string[] = [];

  const decision = authorize(auth, "query", "run");
  if (!decision.allow) {
    requiredScopesMissing.push("query:run");
    reasons.push({ code: "SCOPE_MISSING", message: decision.reason ?? "missing query:run scope" });
  }

  const text = query.text.toLowerCase();
  for (const cap of policy.restrictedCapabilities) {
    if (text.includes(cap) || text.includes(cap.replace(/_/g, " "))) {
      reasons.push({
        code: "CAPABILITY_RESTRICTED",
        message: `capability '${cap}' is restricted by tenant policy`,
      });
    }
  }
  for (const cat of policy.blockedCategories) {
    if (text.includes(cat)) {
      reasons.push({ code: "CONTENT_BLOCKED", message: `query references blocked category '${cat}'` });
    }
  }

  const verdict: ValidationVerdict = {
    queryId: query.queryId,
    allow: reasons.length === 0,
    reasons,
  };
  if (requiredScopesMissing.length) verdict.requiredScopesMissing = requiredScopesMissing;
  return verdict;
}
