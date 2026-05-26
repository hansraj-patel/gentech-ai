/**
 * Control-plane gateway (module 12). A thin `node:http` server that fronts the
 * bus + recorder. The actual run path is INJECTED via `submit` — WP-E supplies
 * the real orchestrate+engine host; tests inject a fake. The gateway itself
 * owns only transport: auth handoff (`resolveAuth`), SSE streaming of a
 * trace's live events, and tenant-scoped reads off the recorder.
 *
 * Routes:
 *   POST /query                          -> { jobId, traceId }
 *   GET  /events?traceId=&tenantId=      -> text/event-stream (result.event + job.status.changed)
 *   GET  /jobs/:id?tenantId=             -> JobStatus | 404
 *   GET  /traces/:id?tenantId=           -> { spans, decisions }
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthContext } from "@gentech/contracts";
import { TOPICS } from "@gentech/contracts";
import { resolveAuth } from "@gentech/iam";
import type { InProcessEventBus } from "./bus.js";
import type { Recorder } from "./recorder.js";

/** The injected run path. WP-E wires orchestrate→engine; tests pass a fake. */
export type SubmitFn = (
  query: { text: string; sources?: string[] },
  auth: AuthContext,
) => Promise<{ jobId: string; traceId: string }>;

export interface GatewayOptions {
  bus: InProcessEventBus;
  recorder: Recorder;
  submit: SubmitFn;
}

export class Gateway {
  private readonly bus: InProcessEventBus;
  private readonly recorder: Recorder;
  private readonly submit: SubmitFn;
  private readonly server: Server;

  constructor(opts: GatewayOptions) {
    this.bus = opts.bus;
    this.recorder = opts.recorder;
    this.submit = opts.submit;
    this.server = createServer((req, res) => {
      this.handle(req, res).catch((err) => sendJson(res, 500, { error: String(err) }));
    });
  }

  /** Start listening. `0` picks an ephemeral port; resolves with the bound port. */
  listen(port = 0): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(port, () => {
        resolve((this.server.address() as AddressInfo).port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (method === "POST" && path === "/query") return this.postQuery(req, res);
    if (method === "GET" && path === "/events") return this.getEvents(url, res);

    const jobMatch = /^\/jobs\/([^/]+)$/.exec(path);
    if (method === "GET" && jobMatch) return this.getJob(decodeURIComponent(jobMatch[1]!), url, res);

    const traceMatch = /^\/traces\/([^/]+)$/.exec(path);
    if (method === "GET" && traceMatch)
      return this.getTrace(decodeURIComponent(traceMatch[1]!), url, res);

    sendJson(res, 404, { error: "not_found" });
  }

  /** POST /query — resolve auth from a role header, call the injected submit. */
  private async postQuery(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJson(req);
    const text = typeof body.text === "string" ? body.text : "";
    if (!text) return sendJson(res, 400, { error: "missing query text" });

    const auth = authFromRequest(req, body);
    const sources = Array.isArray(body.sources) ? (body.sources as string[]) : undefined;
    const ids = await this.submit({ text, sources }, auth);
    sendJson(res, 200, ids);
  }

  /**
   * GET /events — Server-Sent Events. Streams `result.event` and
   * `job.status.changed` for one (tenantId, traceId). Replays already-buffered
   * matching events first, then subscribes for live ones; tenant-scoped.
   */
  private getEvents(url: URL, res: ServerResponse): void {
    const traceId = url.searchParams.get("traceId") ?? "";
    const tenantId = url.searchParams.get("tenantId") ?? "";
    if (!traceId || !tenantId) {
      sendJson(res, 400, { error: "traceId and tenantId required" });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const streamable = new Set<string>([TOPICS.resultEvent, TOPICS.jobStatusChanged]);

    // Subscribe BEFORE replaying so no live event is missed in the gap.
    const off = this.bus.subscribe("*", (event, topic) => {
      if (!streamable.has(topic)) return;
      if (event.tenantId !== tenantId || event.traceId !== traceId) return;
      writeSse(res, topic, event);
    });

    for (const event of this.bus.replay({ tenantId, traceId })) {
      // replay carries no topic; re-filter on the envelope `type`.
      if (event.type === TOPICS.resultEvent || event.type === TOPICS.jobStatusChanged) {
        writeSse(res, event.type, event);
      }
    }

    res.on("close", off);
  }

  /** GET /jobs/:id — tenant-scoped latest JobStatus. */
  private getJob(jobId: string, url: URL, res: ServerResponse): void {
    const tenantId = url.searchParams.get("tenantId") ?? "";
    if (!tenantId) return sendJson(res, 400, { error: "tenantId required" });
    const status = this.recorder.jobStatus(tenantId, jobId);
    if (!status) return sendJson(res, 404, { error: "not_found" });
    sendJson(res, 200, status);
  }

  /** GET /traces/:id — tenant-scoped spans + decisions for a trace. */
  private getTrace(traceId: string, url: URL, res: ServerResponse): void {
    const tenantId = url.searchParams.get("tenantId") ?? "";
    if (!tenantId) return sendJson(res, 400, { error: "tenantId required" });
    sendJson(res, 200, {
      spans: this.recorder.spansFor(tenantId, traceId),
      decisions: this.recorder.decisionsFor(tenantId, traceId),
    });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Resolve an AuthContext from a role header / body (no real IdP in v1). */
function authFromRequest(req: IncomingMessage, body: Record<string, unknown>): AuthContext {
  const header = req.headers["x-role"];
  const headerRole = Array.isArray(header) ? header[0] : header;
  const role =
    headerRole ?? (typeof body.role === "string" ? (body.role as string) : undefined);
  const tenantHeader = req.headers["x-tenant-id"];
  const tenantId = Array.isArray(tenantHeader) ? tenantHeader[0] : tenantHeader;
  const overrides: Partial<AuthContext> = {};
  if (role) overrides.roles = [role];
  if (tenantId) overrides.tenantId = tenantId;
  return resolveAuth(overrides);
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}
