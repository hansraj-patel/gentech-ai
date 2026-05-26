/**
 * Headless smoke test (no browser) for the apps/web end-to-end path.
 *
 * Starts a real control-plane gateway, POSTs queries to /query, then opens the
 * SSE /events stream via a fetch streaming reader (EventSource has no Node
 * global here) and asserts:
 *   1. "how many white cars?" yields a ui.spec event with >= 1 block.
 *   2. "run face recognition on everyone" yields a blocked notice ui.spec.
 *
 * Exits non-zero on any failure.
 */
import { createGatewayHost } from "@gentech/control-plane";
import type { UISpec } from "@gentech/contracts";

const TENANT = "ten_demo";

interface SseEvent {
  event: string;
  data: unknown;
}

/** Read the SSE stream until `predicate` matches an event or it times out. */
async function readUntil(
  url: string,
  predicate: (e: SseEvent) => boolean,
  timeoutMs = 8000,
): Promise<SseEvent> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const res = await fetch(url, {
    headers: { accept: "text/event-stream" },
    signal: ctrl.signal,
  });
  if (!res.body) throw new Error("no SSE body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evMatch = /^event: (.*)$/m.exec(raw);
        const dataMatch = /^data: (.*)$/m.exec(raw);
        if (!evMatch || !dataMatch) continue;
        const parsed: SseEvent = {
          event: evMatch[1]!.trim(),
          data: JSON.parse(dataMatch[1]!),
        };
        if (predicate(parsed)) {
          ctrl.abort();
          return parsed;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    try {
      await reader.cancel();
    } catch {
      /* aborted */
    }
  }
  throw new Error("stream ended without a matching event");
}

function payloadOf(e: SseEvent): UISpec {
  const env = e.data as { payload?: unknown };
  return (env.payload ?? env) as UISpec;
}

async function submit(base: string, text: string): Promise<{ jobId: string; traceId: string }> {
  const res = await fetch(`${base}/query`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-role": "analyst", "x-tenant-id": TENANT },
    body: JSON.stringify({ text, role: "analyst", tenantId: TENANT }),
  });
  if (!res.ok) throw new Error(`POST /query failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { jobId: string; traceId: string };
}

async function main(): Promise<void> {
  const { gateway } = createGatewayHost();
  const port = await gateway.listen(0);
  const base = `http://localhost:${port}`;
  console.log(`[smoke] gateway up on ${base}`);

  try {
    // ── Case 1: a normal query renders a UISpec with blocks ───────────────────
    const q1 = await submit(base, "how many white cars?");
    console.log(`[smoke] case1 submitted job=${q1.jobId} trace=${q1.traceId}`);
    const ev1 = await readUntil(
      `${base}/events?traceId=${q1.traceId}&tenantId=${TENANT}`,
      (e) => e.event === "ui.spec",
    );
    const spec1 = payloadOf(ev1);
    if (!Array.isArray(spec1.blocks) || spec1.blocks.length < 1) {
      throw new Error(`case1: expected >=1 block, got ${spec1.blocks?.length}`);
    }
    console.log(
      `[smoke] case1 OK — ui.spec with ${spec1.blocks.length} block(s): ${spec1.blocks
        .map((b) => b.kind)
        .join(", ")}`,
    );

    // ── Case 2: a denied query yields a blocked notice spec ───────────────────
    const q2 = await submit(base, "run face recognition on everyone");
    console.log(`[smoke] case2 submitted job=${q2.jobId} trace=${q2.traceId}`);
    const ev2 = await readUntil(
      `${base}/events?traceId=${q2.traceId}&tenantId=${TENANT}`,
      (e) => e.event === "ui.spec",
    );
    const spec2 = payloadOf(ev2);
    const blocked = spec2.blocks.some(
      (b) =>
        b.kind === "summary_card" &&
        /block|denied|policy/i.test(
          `${String(b.props.title ?? "")} ${String(b.props.body ?? "")}`,
        ),
    );
    if (!blocked) {
      throw new Error(
        `case2: expected a blocked notice; got blocks ${JSON.stringify(spec2.blocks.map((b) => b.kind))}`,
      );
    }
    console.log(`[smoke] case2 OK — denied query produced a blocked notice spec`);

    console.log("\n[smoke] SUCCESS — end-to-end path verified (query → SSE → UISpec).");
  } finally {
    await gateway.close();
  }
}

main().catch((err) => {
  console.error("[smoke] FAILURE:", err);
  process.exit(1);
});
