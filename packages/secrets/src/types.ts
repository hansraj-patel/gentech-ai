/**
 * Owned contract types for module 02 (credential & secrets vault). Kept LOCAL —
 * notably `SecretRef` is branded here rather than added to contracts/src/ids.ts,
 * which the execution-plane agent is concurrently editing.
 */
declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

/** Opaque handle to a stored secret. Reveals nothing about the underlying value. */
export type SecretRef = Brand<string, "SecretRef">;

/** Short-lived decrypted credential. Callers MUST discard after `expiresAt`. */
export interface EphemeralCredential {
  secretRef: SecretRef;
  value: string;
  expiresAt: string; // RFC-3339 UTC
}

/** Internal at-rest record — ciphertext only, NEVER the raw value. */
export interface StoredSecret {
  tenantId: string;
  ciphertext: string;
  iv: string;
  authTag: string;
  createdAt: string;
}
