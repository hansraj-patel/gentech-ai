import { describe, it, expect } from "vitest";
import { SecretsVault } from "../dist/index.js";
import type { AuthContext } from "@gentech/contracts";

const auth = (tenantId: string): AuthContext => ({
  tenantId,
  userId: "usr_1",
  roles: ["operator"],
  scopes: ["camera:write:*"],
  attrs: {},
});

const RAW = "rtsp://admin:hunter2@cam.example/stream";

describe("SecretsVault", () => {
  it("returns an opaque ref that reveals nothing about the value", () => {
    const vault = new SecretsVault();
    const ref = vault.store(auth("ten_a"), RAW);
    expect(ref).toMatch(/^sec_[0-9a-f]+$/);
    expect(ref).not.toContain("hunter2");
    expect(ref).not.toContain("admin");
  });

  it("resolves to the original value with a future expiry", () => {
    const vault = new SecretsVault({ ttlSec: 60 });
    const a = auth("ten_a");
    const ref = vault.store(a, RAW);
    const cred = vault.resolve(a, ref);
    expect(cred.value).toBe(RAW);
    expect(new Date(cred.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it("isolates tenants: another tenant cannot resolve the ref", () => {
    const vault = new SecretsVault();
    const ref = vault.store(auth("ten_a"), RAW);
    expect(() => vault.resolve(auth("ten_b"), ref)).toThrowError(/not found for this tenant/);
  });

  it("denies a forged/guessed ref", () => {
    const vault = new SecretsVault();
    vault.store(auth("ten_a"), RAW);
    expect(() => vault.resolve(auth("ten_a"), "sec_deadbeef" as never)).toThrowError(/not found/);
  });

  it("rotates under the same ref; old value no longer resolves", () => {
    const vault = new SecretsVault();
    const a = auth("ten_a");
    const ref = vault.store(a, RAW);
    vault.rotate(a, ref, "rtsp://admin:newpass@cam/stream");
    expect(vault.resolve(a, ref).value).toBe("rtsp://admin:newpass@cam/stream");
  });

  it("NEVER leaks the raw value when serialized or in thrown errors", () => {
    const vault = new SecretsVault();
    const a = auth("ten_a");
    vault.store(a, RAW);
    expect(JSON.stringify(vault)).not.toContain("hunter2");
    try {
      vault.resolve(auth("ten_b"), "sec_x" as never);
    } catch (err) {
      expect(JSON.stringify(err instanceof Error ? { ...err, message: err.message } : err)).not.toContain("hunter2");
    }
  });
});
