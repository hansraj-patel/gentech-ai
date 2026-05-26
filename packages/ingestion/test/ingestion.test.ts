import { describe, it, expect } from "vitest";
import {
  MediaSegmentSchema,
  UsageEventSchema,
  TOPICS,
  type AuthContext,
} from "@gentech/contracts";
import { SecretsVault } from "@gentech/secrets";
import { IngestionGateway } from "../dist/index.js";

const auth = (tenantId: string): AuthContext => ({
  tenantId,
  userId: "usr_1",
  roles: ["operator"],
  scopes: ["camera:write:*"],
  attrs: {},
});

const CAM_SECRET = "rtsp://admin:hunter2@cam.example/stream";
const chunk = (n: number) => new Uint8Array(n);

/** Build a gateway with a recording emit sink and a 2-chunk window. */
function makeGateway(opts: { windowChunks?: number } = {}) {
  const vault = new SecretsVault({ ttlSec: 60 });
  const events: Array<{ topic: string; payload: unknown }> = [];
  const gw = new IngestionGateway({
    vault,
    emit: (topic, payload) => events.push({ topic, payload }),
    segmenter: { windowChunks: opts.windowChunks ?? 2 },
  });
  return { vault, gw, events };
}

describe("chunk reassembly", () => {
  it("is idempotent + out-of-order tolerant", () => {
    const { gw } = makeGateway();
    const reg = gw.registerSource({ kind: "upload", tenantId: "ten_a" });
    const s = gw.openUpload({ sourceId: reg.sourceId, tenantId: "ten_a" });

    // Out of order: 2 before 0/1.
    gw.pushChunk(s.sessionId, 2, chunk(10));
    gw.pushChunk(s.sessionId, 0, chunk(10));
    // Duplicate of 2 — must be a no-op (no double count).
    const dup = gw.pushChunk(s.sessionId, 2, chunk(10));
    expect(dup.receipt.duplicate).toBe(true);
    gw.pushChunk(s.sessionId, 1, chunk(10));

    expect(s.receivedChunks.size).toBe(3);
    expect(s.totalBytes).toBe(30); // duplicate didn't add bytes
    expect(s.contiguousCount()).toBe(3); // 0,1,2 contiguous
  });

  it("resumes from the last acked chunk after a kill", () => {
    const { gw } = makeGateway();
    const reg = gw.registerSource({ kind: "upload", tenantId: "ten_a" });
    const s = gw.openUpload({ sourceId: reg.sourceId, tenantId: "ten_a" });
    gw.pushChunk(s.sessionId, 0, chunk(5));
    gw.pushChunk(s.sessionId, 1, chunk(5));
    // "kill" — chunk 2 never arrived; resume point is index 2.
    expect(s.nextExpectedIndex()).toBe(2);
  });
});

describe("progressive segmentation invariants", () => {
  it("emits monotonic indices and exactly one final segment", () => {
    const { gw, events } = makeGateway({ windowChunks: 2 });
    const reg = gw.registerSource({ kind: "upload", tenantId: "ten_a" });
    const s = gw.openUpload({ sourceId: reg.sourceId, tenantId: "ten_a", jobId: "job_1" });

    // Finite upload of 5 chunks.
    gw.finalizeUpload(s.sessionId, 5);
    gw.pushChunk(s.sessionId, 0, chunk(8));
    const r1 = gw.pushChunk(s.sessionId, 1, chunk(8)); // window [0,1] full -> 1 segment, progressive
    expect(r1.segments.length).toBe(1);
    expect(r1.segments[0]!.final).toBe(false);

    gw.pushChunk(s.sessionId, 2, chunk(8));
    gw.pushChunk(s.sessionId, 3, chunk(8)); // window [2,3]
    const last = gw.pushChunk(s.sessionId, 4, chunk(8)); // completes -> trailing window -> final

    const created = events.filter((e) => e.topic === TOPICS.mediaSegmentCreated).map((e) => e.payload as any);
    const indices = created.map((s2) => s2.index);
    expect(indices).toEqual([0, 1, 2]); // monotonic, no gaps
    const finals = created.filter((s2) => s2.final);
    expect(finals.length).toBe(1);
    expect(finals[0]!.index).toBe(2);
    expect(last.segments.at(-1)!.final).toBe(true);
  });

  it("emits at least one segment before the upload completes (FR-4)", () => {
    const { gw } = makeGateway({ windowChunks: 2 });
    const reg = gw.registerSource({ kind: "upload", tenantId: "ten_a" });
    const s = gw.openUpload({ sourceId: reg.sourceId, tenantId: "ten_a" });
    gw.pushChunk(s.sessionId, 0, chunk(8));
    const r = gw.pushChunk(s.sessionId, 1, chunk(8));
    expect(r.segments.length).toBe(1);
    expect(s.isComplete()).toBe(false); // never finalized — still emitted progressively
  });

  it("every emitted MediaSegment validates against MediaSegmentSchema", () => {
    const { gw, events } = makeGateway({ windowChunks: 2 });
    const reg = gw.registerSource({ kind: "upload", tenantId: "ten_a" });
    const s = gw.openUpload({ sourceId: reg.sourceId, tenantId: "ten_a" });
    gw.finalizeUpload(s.sessionId, 3);
    for (let i = 0; i < 3; i++) gw.pushChunk(s.sessionId, i, chunk(8));

    const created = events.filter((e) => e.topic === TOPICS.mediaSegmentCreated);
    expect(created.length).toBeGreaterThan(0);
    for (const e of created) {
      expect(() => MediaSegmentSchema.parse(e.payload)).not.toThrow();
      const seg = e.payload as any;
      expect(seg.storageRef).toMatch(/^ingest:\/\//); // opaque, not bytes
      expect(seg.storageRef).not.toMatch(/[A-Za-z0-9+/]{40,}/); // not base64 byte blob
    }
  });
});

describe("live source credentials (FR-6)", () => {
  it("resolves the SecretRef via the vault at connect time", () => {
    const { vault, gw } = makeGateway();
    const ref = vault.store(auth("ten_a"), CAM_SECRET);
    const reg = gw.registerSource({
      kind: "live",
      tenantId: "ten_a",
      protocol: "rtsp",
      uri: "rtsp://cam.local/stream",
      secretRef: ref as any,
    });
    let seenValue = "";
    const health = gw.sources.connect(auth("ten_a"), reg.sourceId, (probe) => {
      seenValue = probe.password; // vault was consulted
      return true;
    });
    expect(seenValue).toBe(CAM_SECRET);
    expect(health).toBe("online");
  });

  it("never leaks the raw credential into any registration/segment/event", () => {
    const { vault, gw, events } = makeGateway({ windowChunks: 2 });
    const ref = vault.store(auth("ten_a"), CAM_SECRET);
    const reg = gw.registerSource({
      kind: "live",
      tenantId: "ten_a",
      protocol: "rtsp",
      uri: "rtsp://cam.local/stream",
      secretRef: ref as any,
    });
    gw.sources.connect(auth("ten_a"), reg.sourceId);

    // Also push some bytes so segment/usage events exist to scan.
    const up = gw.registerSource({ kind: "upload", tenantId: "ten_a" });
    const s = gw.openUpload({ sourceId: up.sourceId, tenantId: "ten_a" });
    gw.finalizeUpload(s.sessionId, 2);
    gw.pushChunk(s.sessionId, 0, chunk(8));
    gw.pushChunk(s.sessionId, 1, chunk(8));

    const haystack = JSON.stringify({ reg, events });
    expect(haystack).not.toContain("hunter2");
    expect(haystack).not.toContain(CAM_SECRET);
    expect(JSON.stringify(reg)).not.toContain("hunter2");
  });
});

describe("usage emission", () => {
  it("emits a UsageEvent for stored bytes that validates against its schema", () => {
    const { gw, events } = makeGateway({ windowChunks: 2 });
    const reg = gw.registerSource({ kind: "upload", tenantId: "ten_a" });
    const s = gw.openUpload({ sourceId: reg.sourceId, tenantId: "ten_a", jobId: "job_1" });
    gw.finalizeUpload(s.sessionId, 2);
    gw.pushChunk(s.sessionId, 0, chunk(1024));
    gw.pushChunk(s.sessionId, 1, chunk(1024));

    const usage = events.filter((e) => e.topic === TOPICS.usageRecorded).map((e) => e.payload);
    expect(usage.length).toBeGreaterThan(0);
    for (const u of usage) {
      expect(() => UsageEventSchema.parse(u)).not.toThrow();
    }
    const totalStorage = usage.reduce((acc, u: any) => acc + (u.storageGbHours ?? 0), 0);
    expect(totalStorage).toBeGreaterThan(0);
  });
});
