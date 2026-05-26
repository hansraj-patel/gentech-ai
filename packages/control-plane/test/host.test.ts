import { describe, it, expect } from "vitest";
import type { AuthContext, Event, UISpec } from "@gentech/contracts";
import { resolveAuth } from "@gentech/iam";
import {
  InProcessEventBus,
  Recorder,
  createHost,
  createGatewayHost,
  UI_SPEC_TOPIC,
} from "../dist/index.js";

const TENANT = "ten_host_test";

/** An analyst auth (carries the `query:run` scope so the safety gate allows). */
function analystAuth(): AuthContext {
  return resolveAuth({ tenantId: TENANT, roles: ["analyst"] });
}

describe("createHost — authorized query runs end-to-end and renders UI", () => {
  it("emits a non-empty UISpec on ui.spec and produces result.events", async () => {
    const bus = new InProcessEventBus();
    const recorder = new Recorder(bus);
    const host = createHost({ bus, recorder });

    const specs: UISpec[] = [];
    bus.subscribe(UI_SPEC_TOPIC, (e: Event) => specs.push(e.payload as UISpec));

    const out = await host.submit({
      text: "how many white cars?",
      scenario: "parking_lot_daytime",
      auth: analystAuth(),
    });

    expect(out.ran).toBe(true);
    expect(out.status).not.toBe("blocked");

    // A non-empty UISpec was emitted with at least one block.
    expect(specs).toHaveLength(1);
    const spec = specs.at(-1)!;
    expect(spec.blocks.length).toBeGreaterThanOrEqual(1);
    expect(spec.specId).toBe(out.specId);

    // result.events were produced on the bus (the engine ran).
    const results = bus.replay({ tenantId: TENANT, jobId: out.jobId }).filter(
      (e) => e.type === "result.event",
    );
    expect(results.length).toBeGreaterThan(0);

    // the engine actually metered usage.
    const usage = bus.replay({ tenantId: TENANT }).filter((e) => e.type === "usage.recorded");
    expect(usage.length).toBeGreaterThan(0);

    recorder.close();
  });
});

describe("createHost — denied query is blocked and never runs the engine", () => {
  it("returns blocked, emits a notice UISpec, and records zero inference usage", async () => {
    const bus = new InProcessEventBus();
    const recorder = new Recorder(bus);
    const host = createHost({ bus, recorder });

    const specs: UISpec[] = [];
    bus.subscribe(UI_SPEC_TOPIC, (e: Event) => specs.push(e.payload as UISpec));

    const out = await host.submit({
      text: "run face recognition on everyone",
      scenario: "parking_lot_daytime",
      auth: analystAuth(),
    });

    expect(out.status).toBe("blocked");
    expect(out.ran).toBe(false);

    // a notice UISpec was still produced.
    expect(specs).toHaveLength(1);
    expect(specs[0]!.blocks.length).toBeGreaterThanOrEqual(1);

    // the engine never ran: no usage.recorded events at all.
    const usage = bus.replay({}).filter((e) => e.type === "usage.recorded");
    expect(usage).toHaveLength(0);

    // and no pipeline was created.
    const pipelines = bus.replay({}).filter((e) => e.type === "pipeline.created");
    expect(pipelines).toHaveLength(0);

    recorder.close();
  });
});

describe("createGatewayHost — gateway streams ui.spec over SSE", () => {
  it("POST /query runs the host and GET /events forwards the ui.spec event", async () => {
    const { gateway, bus } = createGatewayHost();
    const port = await gateway.listen(0);
    const base = `http://127.0.0.1:${port}`;

    try {
      const postRes = await fetch(`${base}/query`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-role": "analyst",
          "x-tenant-id": TENANT,
        },
        body: JSON.stringify({ text: "how many white cars?" }),
      });
      expect(postRes.status).toBe(200);
      const ids = (await postRes.json()) as { jobId: string; traceId: string };
      expect(ids.traceId).toBeTruthy();

      // The run already completed synchronously and buffered events; replay them.
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const evRes = await fetch(
        `${base}/events?traceId=${ids.traceId}&tenantId=${TENANT}`,
        { signal: ctrl.signal },
      );
      const reader = evRes.body!.getReader();
      let buf = "";
      for (let i = 0; i < 50; i++) {
        const { value, done } = await reader.read();
        if (value) buf += new TextDecoder().decode(value);
        if (done || buf.includes("event: ui.spec")) break;
      }
      expect(buf).toContain("event: ui.spec");
      clearTimeout(timer);
      await reader.cancel();
    } finally {
      await gateway.close();
      bus; // keep ref
    }
  });
});
