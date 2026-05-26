import type { SafetyPolicy } from "./types.js";

/** Capabilities off by default for privacy/compliance (FR-2). */
export const DEFAULT_RESTRICTED_CAPABILITIES = [
  "face_recognition",
  "person_reidentification",
  "biometric_identification",
];

/** Categories a query may not request, and content may not contain (FR-3/5). */
export const DEFAULT_BLOCKED_CATEGORIES = ["nsfw", "csam", "explicit"];

export function defaultSafetyPolicy(tenantId: string): SafetyPolicy {
  return {
    tenantId,
    blockedCategories: [...DEFAULT_BLOCKED_CATEGORIES],
    restrictedCapabilities: [...DEFAULT_RESTRICTED_CAPABILITIES],
  };
}
