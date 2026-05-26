import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { StoredSecret } from "./types.js";

/** Pluggable at-rest store (Vault / AWS SM / GCP SM in production). */
export interface SecretsBackend {
  put(tenantId: string, ref: string, secret: StoredSecret): void;
  get(tenantId: string, ref: string): StoredSecret | undefined;
  delete(tenantId: string, ref: string): void;
}

/** Dev backend — tenant-namespaced in-memory map of ciphertext records. */
export class InMemorySecretsBackend implements SecretsBackend {
  private readonly store = new Map<string, StoredSecret>();
  private key(tenantId: string, ref: string): string {
    return `${tenantId}::${ref}`;
  }
  put(tenantId: string, ref: string, secret: StoredSecret): void {
    this.store.set(this.key(tenantId, ref), secret);
  }
  get(tenantId: string, ref: string): StoredSecret | undefined {
    return this.store.get(this.key(tenantId, ref));
  }
  delete(tenantId: string, ref: string): void {
    this.store.delete(this.key(tenantId, ref));
  }
}

export interface EncryptedBlob {
  ciphertext: string;
  iv: string;
  authTag: string;
}

/** AES-256-GCM. Encrypted-at-rest; dev key derived locally when none is supplied. */
export class Cipher {
  private readonly key: Buffer;
  constructor(key?: Buffer | string) {
    if (Buffer.isBuffer(key)) {
      this.key = key;
    } else {
      const material = key ?? process.env.GENTECH_SECRETS_KEY ?? "dev-insecure-key";
      this.key = createHash("sha256").update(material).digest();
    }
  }
  encrypt(plaintext: string): EncryptedBlob {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return {
      ciphertext: enc.toString("base64"),
      iv: iv.toString("base64"),
      authTag: c.getAuthTag().toString("base64"),
    };
  }
  decrypt(blob: EncryptedBlob): string {
    const d = createDecipheriv("aes-256-gcm", this.key, Buffer.from(blob.iv, "base64"));
    d.setAuthTag(Buffer.from(blob.authTag, "base64"));
    return Buffer.concat([d.update(Buffer.from(blob.ciphertext, "base64")), d.final()]).toString("utf8");
  }
}
