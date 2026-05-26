/**
 * Browser API client. Imports ONLY types from @gentech/contracts — never the
 * control-plane (node:http). Talks to the gateway via fetch + EventSource
 * through Vite's /api proxy.
 */
import type {
  JobStatus,
  ResultEvent,
  TraceSpan,
  DecisionLog,
  UISpec,
} from "@gentech/contracts";

export type Role = "analyst" | "operator" | "viewer";

export interface SubmitArgs {
  text: string;
  role: Role;
  tenantId: string;
  scenario?: string;
}

export interface SubmitResult {
  jobId: string;
  traceId: string;
}

/** POST /api/query — enqueue a natural-language query, get back ids. */
export async function submitQuery(args: SubmitArgs): Promise<SubmitResult> {
  const res = await fetch("/api/query", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-role": args.role,
      "x-tenant-id": args.tenantId,
    },
    body: JSON.stringify({
      text: args.text,
      role: args.role,
      tenantId: args.tenantId,
      scenario: args.scenario,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`submitQuery failed (${res.status}): ${detail}`);
  }
  return (await res.json()) as SubmitResult;
}

export interface StreamHandlers {
  onUISpec?: (spec: UISpec) => void;
  onResult?: (result: ResultEvent) => void;
  onJobStatus?: (status: JobStatus) => void;
  onError?: (err: Event) => void;
}

/**
 * GET /api/events?traceId=&tenantId= — open an EventSource and dispatch by SSE
 * event name. The gateway wraps each payload in a §7 envelope `{ payload, ... }`.
 * Returns a close function.
 */
export function streamEvents(
  traceId: string,
  tenantId: string,
  handlers: StreamHandlers,
): () => void {
  const url = `/api/events?traceId=${encodeURIComponent(traceId)}&tenantId=${encodeURIComponent(
    tenantId,
  )}`;
  const es = new EventSource(url);

  const parse = <T>(ev: MessageEvent): T | undefined => {
    try {
      const env = JSON.parse(ev.data) as { payload?: unknown };
      return (env?.payload ?? env) as T;
    } catch {
      return undefined;
    }
  };

  es.addEventListener("ui.spec", (ev) => {
    const spec = parse<UISpec>(ev as MessageEvent);
    if (spec) handlers.onUISpec?.(spec);
  });
  es.addEventListener("result.event", (ev) => {
    const r = parse<ResultEvent>(ev as MessageEvent);
    if (r) handlers.onResult?.(r);
  });
  es.addEventListener("job.status.changed", (ev) => {
    const s = parse<JobStatus>(ev as MessageEvent);
    if (s) handlers.onJobStatus?.(s);
  });
  es.onerror = (err) => handlers.onError?.(err);

  return () => es.close();
}

export interface TraceResponse {
  spans: TraceSpan[];
  decisions: DecisionLog[];
}

/** GET /api/jobs/:id?tenantId= — latest JobStatus, or null on 404. */
export async function fetchJob(jobId: string, tenantId: string): Promise<JobStatus | null> {
  const res = await fetch(`/api/jobs/${encodeURIComponent(jobId)}?tenantId=${encodeURIComponent(tenantId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetchJob failed (${res.status})`);
  return (await res.json()) as JobStatus;
}

/** GET /api/traces/:id?tenantId= — spans + decisions for the trace. */
export async function fetchTrace(traceId: string, tenantId: string): Promise<TraceResponse> {
  const res = await fetch(`/api/traces/${encodeURIComponent(traceId)}?tenantId=${encodeURIComponent(tenantId)}`);
  if (!res.ok) throw new Error(`fetchTrace failed (${res.status})`);
  return (await res.json()) as TraceResponse;
}
