import type { SafetyVerdict } from "./types.js";

export interface ClassifyInput {
  /** Unsafe/NSFW score 0..1, supplied by inference (mocked in v1 by module 13). */
  score: number;
  /** Optional explicit category override, e.g. "restricted". */
  category?: string;
  segmentId?: string;
}

export const NSFW_BLUR_THRESHOLD = 0.5;
export const NSFW_BLOCK_THRESHOLD = 0.85;

/**
 * Pure threshold → action mapping (FR-4). The *score* is faked upstream; this
 * decision logic is real: restricted → block, high nsfw → block, mid nsfw → blur,
 * otherwise allow.
 */
export function classifySafety(input: ClassifyInput): SafetyVerdict {
  const { score } = input;
  let category: SafetyVerdict["category"];
  let action: SafetyVerdict["action"];

  if (input.category === "restricted") {
    category = "restricted";
    action = "block";
  } else if (score >= NSFW_BLOCK_THRESHOLD) {
    category = "nsfw";
    action = "block";
  } else if (score >= NSFW_BLUR_THRESHOLD) {
    category = "nsfw";
    action = "blur";
  } else {
    category = "safe";
    action = "allow";
  }

  const verdict: SafetyVerdict = { category, score, action };
  if (input.segmentId) verdict.segmentId = input.segmentId;
  return verdict;
}
