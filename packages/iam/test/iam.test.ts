import { describe, it, expect } from "vitest";
import {
  authorize,
  matchScope,
  priorityFor,
  checkQuota,
  resolveAuth,
  defaultGovernance,
} from "../dist/index.js";
import type { AuthContext } from "@gentech/contracts";

const analyst = (over: Partial<AuthContext> = {}): AuthContext => resolveAuth(over);

describe("matchScope", () => {
  it("matches exact, lone-*, single-segment, and trailing wildcards", () => {
    expect(matchScope("query:run", "query:run")).toBe(true);
    expect(matchScope("*", "anything:at:all")).toBe(true);
    expect(matchScope("camera:read:*", "camera:read:src_1")).toBe(true);
    expect(matchScope("camera:read:*", "camera:read")).toBe(true); // trailing covers shorter
    expect(matchScope("analytics:*", "analytics:count")).toBe(true);
    expect(matchScope("query:run", "query:write")).toBe(false);
    expect(matchScope("camera:read", "camera:write")).toBe(false);
  });
});

describe("authorize", () => {
  it("allows a scope the principal holds (happy path)", () => {
    expect(authorize(analyst(), "query", "run").allow).toBe(true);
  });

  it("default-denies an ungranted action", () => {
    const d = authorize(analyst({ roles: [], scopes: [] }), "pipeline", "deploy");
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("no grant");
  });

  it("grants via role permissions (RBAC), not just explicit scopes", () => {
    // analyst role grants camera:read:* even with empty explicit scopes
    expect(authorize(analyst({ scopes: [] }), "camera", "read").allow).toBe(true);
  });

  it("explicit deny wins over an otherwise-granted scope", () => {
    const d = authorize(analyst(), "query", "run", [
      { effect: "deny", action: "query", resource: "*" },
    ]);
    expect(d.allow).toBe(false);
    expect(d.reason).toContain("denied by policy");
  });

  it("honors ABAC `when` against attrs", () => {
    const auth = analyst({ scopes: [], roles: [], attrs: { region: "eu" } });
    const rules = [{ effect: "allow" as const, action: "query", resource: "run", when: { region: "eu" } }];
    expect(authorize(auth, "query", "run", rules).allow).toBe(true);
    // attr mismatch → rule does not apply → default deny
    const auth2 = analyst({ scopes: [], roles: [], attrs: { region: "us" } });
    expect(authorize(auth2, "query", "run", rules).allow).toBe(false);
  });

  it("tenant_admin (*) is allowed anything", () => {
    expect(authorize(analyst({ roles: ["tenant_admin"], scopes: [] }), "pipeline", "deploy").allow).toBe(true);
  });
});

describe("priorityFor", () => {
  it("derives priority from the highest-privileged role", () => {
    expect(priorityFor(analyst({ roles: ["viewer"] }))).toBe(3);
    expect(priorityFor(analyst({ roles: ["analyst"] }))).toBe(5);
    expect(priorityFor(analyst({ roles: ["operator"] }))).toBe(7);
    expect(priorityFor(analyst({ roles: ["operator", "viewer"] }))).toBe(7); // max wins
    expect(priorityFor(analyst({ roles: ["unknown"] }))).toBe(5); // default
  });
});

describe("checkQuota", () => {
  it("denies over per-user concurrency and over team credit quota", () => {
    const gov = { ...defaultGovernance("ten_dev"), teamQuotas: [{ team: "ops", maxCredits: 100 }] };
    expect(checkQuota(analyst(), { concurrentJobs: 6 }, gov).allow).toBe(false);
    expect(checkQuota(analyst(), { concurrentJobs: 5 }, gov).allow).toBe(true);
    expect(checkQuota(analyst(), { team: "ops", credits: 150 }, gov).allow).toBe(false);
    expect(checkQuota(analyst(), { team: "ops", credits: 50 }, gov).allow).toBe(true);
  });
});
