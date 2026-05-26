import type { CompressionPlan, Query } from "@gentech/contracts";

/**
 * FR-6 — decide an upload compression target from the query's analytic needs.
 * Higher-fidelity tasks (plate reading, OCR) demand more resolution/bitrate;
 * counting/coarse detection tolerate aggressive compression. Rules-based and
 * deterministic; emits a rationale for the UI/audit.
 */
export function compressionPlan(query?: Query): CompressionPlan {
  const text = (query?.text ?? "").toLowerCase();
  const needsDetail = /\b(plate|number ?plate|licen[sc]e|anpr|ocr|text|read|face)\b/.test(text);
  const minQuality = query?.constraints?.minQuality;

  if (needsDetail || minQuality === "high") {
    return {
      decidedBy: "agent",
      targetResolution: "1920x1080",
      targetBitrateKbps: 6000,
      targetFps: 25,
      rationale: "Fine-detail task (plate/text/face or high quality requested): preserve resolution & bitrate.",
    };
  }
  if (minQuality === "low") {
    return {
      decidedBy: "agent",
      targetResolution: "854x480",
      targetBitrateKbps: 1200,
      targetFps: 10,
      rationale: "Low-quality constraint: aggressive compression is acceptable.",
    };
  }
  return {
    decidedBy: "agent",
    targetResolution: "1280x720",
    targetBitrateKbps: 2500,
    targetFps: 15,
    rationale: "Standard detection/counting: 720p balances fidelity and upload cost.",
  };
}
