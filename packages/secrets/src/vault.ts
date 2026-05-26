import { randomBytes } from "node:crypto";
import { ContractError, type AuthContext } from "@gentech/contracts";
import { Cipher, InMemorySecretsBackend, type SecretsBackend } from "./backend.js";
import type { EphemeralCredential, SecretRef } from "./types.js";

const DEFAULT_TTL_SEC = 300;

export interface VaultOptions {
  backend?: SecretsBackend;
  cipher?: Cipher;
  /** TTL stamped onto resolved credentials; callers discard after expiry. */
  ttlSec?: number;
}

function forbidden(): never {
  // Same message whether the ref is unknown or cross-tenant — never leak which.
  throw new ContractError({
    code: "SECRET_FORBIDDEN",
    module: "secrets",
    message: "secret not found for this tenant",
    retryable: false,
  });
}

/**
 * Module 02 — Credential & Secrets Vault.
 *
 * Camera credentials are NEVER stored raw: only AES-256-GCM ciphertext is
 * persisted (FR-1/2). `resolve` is tenant-isolated — a `SecretRef` minted under
 * another tenant is denied even if guessed/forged (FR-5) — and returns short-lived
 * material (FR-3). `rotate` re-keys under the same ref (FR-6). No method ever
 * logs or serializes the raw value or the encryption key.
 */
export class SecretsVault {
  private readonly backend: SecretsBackend;
  private readonly cipher: Cipher;
  private readonly ttlSec: number;

  constructor(opts: VaultOptions = {}) {
    this.backend = opts.backend ?? new InMemorySecretsBackend();
    this.cipher = opts.cipher ?? new Cipher();
    this.ttlSec = opts.ttlSec ?? DEFAULT_TTL_SEC;
  }

  /** Encrypt + persist; return an opaque ref. The raw value is discarded here. */
  store(auth: AuthContext, raw: string): SecretRef {
    const ref = `sec_${randomBytes(12).toString("hex")}` as SecretRef;
    const enc = this.cipher.encrypt(raw);
    this.backend.put(auth.tenantId, ref, {
      tenantId: auth.tenantId,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
      createdAt: new Date().toISOString(),
    });
    return ref;
  }

  /** Tenant-checked decrypt → short-lived credential. */
  resolve(auth: AuthContext, ref: SecretRef): EphemeralCredential {
    const rec = this.backend.get(auth.tenantId, ref);
    if (!rec || rec.tenantId !== auth.tenantId) forbidden();
    const value = this.cipher.decrypt(rec);
    return {
      secretRef: ref,
      value,
      expiresAt: new Date(Date.now() + this.ttlSec * 1000).toISOString(),
    };
  }

  /** Re-encrypt under the SAME ref so existing holders keep working (rotation). */
  rotate(auth: AuthContext, ref: SecretRef, newRaw: string): void {
    const rec = this.backend.get(auth.tenantId, ref);
    if (!rec || rec.tenantId !== auth.tenantId) forbidden();
    const enc = this.cipher.encrypt(newRaw);
    this.backend.put(auth.tenantId, ref, {
      ...rec,
      ciphertext: enc.ciphertext,
      iv: enc.iv,
      authTag: enc.authTag,
    });
  }

  /** Redaction: never reveal secrets/keys when the vault is logged or serialized. */
  toJSON(): { module: string; ttlSec: number } {
    return { module: "secrets-vault", ttlSec: this.ttlSec };
  }
}
