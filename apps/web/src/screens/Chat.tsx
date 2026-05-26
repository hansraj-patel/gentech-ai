import React, { useEffect, useRef, useState } from "react";
import { useAuth, useNav } from "../App";
import { submitQuery, streamEvents } from "../api";
import type { JobStatus, ResultEvent, UISpec } from "@gentech/contracts";
import { renderUISpec } from "../ui/registry";

const EXAMPLES = [
  { text: "how many white cars?", denied: false },
  { text: "run face recognition on everyone", denied: true },
];

interface RunState {
  jobId: string;
  traceId: string;
  spec: UISpec | null;
  status: JobStatus | null;
  results: ResultEvent[];
  blocked: boolean;
}

export function Chat(): React.ReactElement {
  const { auth } = useAuth();
  const { go } = useNav();
  const [text, setText] = useState("");
  const [run, setRun] = useState<RunState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeRef = useRef<(() => void) | null>(null);

  useEffect(() => () => closeRef.current?.(), []);

  if (!auth) return <div>Not signed in.</div>;

  async function send(query: string): Promise<void> {
    if (!query.trim() || busy || !auth) return;
    setError(null);
    setBusy(true);
    closeRef.current?.();
    setRun(null);

    try {
      const { jobId, traceId } = await submitQuery({
        text: query.trim(),
        role: auth.role,
        tenantId: auth.tenantId,
      });

      const initial: RunState = {
        jobId,
        traceId,
        spec: null,
        status: null,
        results: [],
        blocked: false,
      };
      setRun(initial);

      closeRef.current = streamEvents(traceId, auth.tenantId, {
        onUISpec: (spec) => {
          const blocked = spec.blocks.some(
            (b) =>
              b.kind === "summary_card" &&
              /block|denied|policy/i.test(
                `${String(b.props.title ?? "")} ${String(b.props.body ?? "")}`,
              ),
          );
          setRun((r) => (r ? { ...r, spec, blocked } : r));
        },
        onResult: (result) =>
          setRun((r) => (r ? { ...r, results: [...r.results, result] } : r)),
        onJobStatus: (status) => setRun((r) => (r ? { ...r, status } : r)),
        onError: () => {
          /* SSE stays open; ignore transient errors */
        },
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const cost = run?.status?.costSoFar;

  return (
    <div className="chat">
      <div className="chat-compose">
        <textarea
          placeholder="Ask in natural language… e.g. how many white cars?"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void send(text);
            }
          }}
          rows={3}
        />
        <div className="chat-actions">
          <div className="examples">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.text}
                className={`example ${ex.denied ? "example-denied" : ""}`}
                onClick={() => {
                  setText(ex.text);
                  void send(ex.text);
                }}
              >
                {ex.denied ? "⛔ " : ""}
                {ex.text}
              </button>
            ))}
          </div>
          <button className="send-btn" disabled={busy || !text.trim()} onClick={() => void send(text)}>
            {busy ? "sending…" : "Send (⌘↵)"}
          </button>
        </div>
        <p className="muted spend-note">
          Spend note: each query is metered against your tenant budget; live{" "}
          <code>costSoFar</code> streams below as the engine runs (credits).
        </p>
      </div>

      {error ? <div className="error-banner">{error}</div> : null}

      {run ? (
        <div className="chat-result">
          <div className="result-meta">
            <span>
              job <code>{run.jobId}</code>
            </span>
            <span>
              trace <code>{run.traceId}</code>
            </span>
            <span className={`status-pill status-${run.status?.state ?? "queued"}`}>
              {run.blocked ? "blocked" : (run.status?.state ?? "queued")}
            </span>
            {cost !== undefined ? <span className="cost-pill">{cost} credits</span> : null}
            {!run.blocked ? (
              <button className="link-btn" onClick={() => go({ name: "job", jobId: run.jobId, traceId: run.traceId })}>
                view job detail →
              </button>
            ) : null}
          </div>

          {run.spec ? (
            renderUISpec(run.spec)
          ) : (
            <div className="awaiting">awaiting generative UI from the render-agent…</div>
          )}

          {run.results.length > 0 ? (
            <details className="raw-results">
              <summary>{run.results.length} raw result event(s)</summary>
              <pre>{JSON.stringify(run.results, null, 2)}</pre>
            </details>
          ) : null}
        </div>
      ) : (
        <div className="chat-empty">
          Type a query or click an example. Watch the <strong>UISpec</strong> blocks stream in
          live — the intelligence is real, the pixels are generated.
        </div>
      )}
    </div>
  );
}
