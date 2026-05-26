/**
 * Fabricate the MediaSegments a scenario would produce. In v1 module 01 (ingestion)
 * doesn't exist, so the demo/tests synthesize segments here. Crucially the mock owns
 * the `storageRef` scheme (`mock://seg/<index>`) that `infer.ts` reads — the engine
 * stays generic and never parses it.
 */
import type { MediaSegment } from "@gentech/contracts";
import { MediaSegmentSchema } from "@gentech/contracts";
import type { Scenario } from "./scenarios.js";

const SEGMENT_SECONDS = 5;

export function mockSegments(scenario: Scenario, tenantId = "ten_demo"): MediaSegment[] {
  const source = scenario.sources[0]!;
  return Array.from({ length: scenario.segmentCount }, (_, i) =>
    MediaSegmentSchema.parse({
      segmentId: `seg_${source.sourceId}_${i}`,
      sourceId: source.sourceId,
      tenantId,
      index: i,
      tStart: i * SEGMENT_SECONDS,
      tEnd: (i + 1) * SEGMENT_SECONDS,
      storageRef: `mock://seg/${i}`,
      codec: "h264",
      final: i === scenario.segmentCount - 1,
    }) as MediaSegment,
  );
}
