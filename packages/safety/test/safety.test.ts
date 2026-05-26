import { describe, it, expect } from "vitest";
import { validateQuery, classifySafety, defaultSafetyPolicy } from "../dist/index.js";
import { resolveAuth } from "@gentech/iam";
import type { Query } from "@gentech/contracts";

const query = (text: string): Query => ({
  queryId: "query_t1",
  tenantId: "ten_dev",
  text,
  sources: ["src_1"],
});

describe("validateQuery", () => {
  it("allows a benign query from an authorized analyst", () => {
    const v = validateQuery(query("how many white cars?"), resolveAuth());
    expect(v.allow).toBe(true);
    expect(v.reasons).toHaveLength(0);
  });

  it("reports missing query:run scope", () => {
    const v = validateQuery(query("how many white cars?"), resolveAuth({ roles: [], scopes: [] }));
    expect(v.allow).toBe(false);
    expect(v.requiredScopesMissing).toContain("query:run");
    expect(v.reasons.some((r) => r.code === "SCOPE_MISSING")).toBe(true);
  });

  it("blocks a restricted capability (face recognition)", () => {
    const v = validateQuery(query("run face recognition on everyone"), resolveAuth());
    expect(v.allow).toBe(false);
    expect(v.reasons.some((r) => r.code === "CAPABILITY_RESTRICTED")).toBe(true);
  });

  it("blocks a blocked-category reference", () => {
    const v = validateQuery(query("find nsfw content"), resolveAuth());
    expect(v.allow).toBe(false);
    expect(v.reasons.some((r) => r.code === "CONTENT_BLOCKED")).toBe(true);
  });

  it("uses an injected authorize (no dependency on real IAM)", () => {
    const v = validateQuery(query("how many cars?"), resolveAuth(), {
      authorize: () => ({ allow: false, reason: "stubbed deny" }),
    });
    expect(v.allow).toBe(false);
    expect(v.requiredScopesMissing).toContain("query:run");
  });

  it("respects a custom policy that allows the capability", () => {
    const policy = { ...defaultSafetyPolicy("ten_dev"), restrictedCapabilities: [] };
    const v = validateQuery(query("run face recognition"), resolveAuth(), { policy });
    expect(v.allow).toBe(true);
  });
});

describe("classifySafety", () => {
  it("maps scores to allow/blur/block and flags restricted", () => {
    expect(classifySafety({ score: 0.1 }).action).toBe("allow");
    expect(classifySafety({ score: 0.5 }).action).toBe("blur");
    expect(classifySafety({ score: 0.84 }).action).toBe("blur");
    expect(classifySafety({ score: 0.85 }).action).toBe("block");
    expect(classifySafety({ score: 0.0, category: "restricted" }).action).toBe("block");
  });

  it("carries segmentId through when provided", () => {
    expect(classifySafety({ score: 0.9, segmentId: "seg_1" }).segmentId).toBe("seg_1");
  });
});
