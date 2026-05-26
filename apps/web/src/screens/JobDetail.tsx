import React, { useEffect, useState } from "react";
import { useAuth } from "../App";
import { fetchJob, fetchTrace, type TraceResponse } from "../api";
import type { JobStatus } from "@gentech/contracts";

interface Props {
  jobId: string;
  traceId: string;
}

export function JobDetail({ jobId, traceId }: Props): React.ReactElement {
  const { auth } = useAuth();
  const [job, setJob] = useState<JobStatus | null>(null);
  const [trace, setTrace] = useState<TraceResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!auth) return;
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const [j, t] = await Promise.all([
          fetchJob(jobId, auth.tenantId),
          fetchTrace(traceId, auth.tenantId),
        ]);
        if (!alive) return;
        setJob(j);
        setTrace(t);
      } catch (e) {
        if (alive) setErr(String(e));
      }
    };
    void tick();
    // Poll while the job is still progressing.
    const id = setInterval(() => {
      if (job && ["succeeded", "failed", "cancelled"].includes(job.state)) return;
      void tick();
    }, 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId, traceId, auth?.tenantId]);

  if (!auth) return <div>Not signed in.</div>;

  const nodeEntries = job ? Object.entries(job.nodeStates) : [];
  // Build a node/edge list. Trace spans (module attribution) approximate the DAG;
  // node states come from the live JobStatus.
  return (
    <div className="job-detail">
      <h2>Job Detail</h2>
      {err ? <div className="error-banner">{err}</div> : null}

      <section className="jd-section">
        <h3>Status</h3>
        {job ? (
          <div className="jd-status">
            <div>
              <span className="muted">state</span>{" "}
              <span className={`status-pill status-${job.state}`}>{job.state}</span>
            </div>
            <div>
              <span className="muted">progress</span> {Math.round(job.progress * 100)}%
            </div>
            <div>
              <span className="muted">cost</span> {job.costSoFar} credits
            </div>
            <div>
              <span className="muted">pipeline</span> <code>{job.pipelineId}</code>
            </div>
          </div>
        ) : (
          <div className="muted">no job status yet…</div>
        )}
      </section>

      <section className="jd-section">
        <h3>Pipeline DAG (nodes)</h3>
        {nodeEntries.length > 0 ? (
          <div className="dag">
            {nodeEntries.map(([nodeId, state], i) => (
              <React.Fragment key={nodeId}>
                <div className={`dag-node node-${state}`}>
                  <div className="dag-node-id">{nodeId}</div>
                  <div className="dag-node-state">{state}</div>
                </div>
                {i < nodeEntries.length - 1 ? <div className="dag-edge">→</div> : null}
              </React.Fragment>
            ))}
          </div>
        ) : (
          <div className="muted">no nodes reported yet…</div>
        )}
      </section>

      <section className="jd-section">
        <h3>Trace spans ({trace?.spans.length ?? 0})</h3>
        {trace && trace.spans.length > 0 ? (
          <table className="spans-table">
            <thead>
              <tr>
                <th>module</th>
                <th>name</th>
                <th>duration</th>
              </tr>
            </thead>
            <tbody>
              {trace.spans.map((s) => (
                <tr key={s.spanId}>
                  <td>{s.module}</td>
                  <td>{s.name}</td>
                  <td>{s.durationMs}ms</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="muted">no spans recorded.</div>
        )}
      </section>

      <section className="jd-section">
        <h3>Decisions ({trace?.decisions.length ?? 0})</h3>
        {trace && trace.decisions.length > 0 ? (
          <ul className="decisions">
            {trace.decisions.map((d, i) => (
              <li key={i}>
                <strong>{d.actor}</strong>: {d.decision}
              </li>
            ))}
          </ul>
        ) : (
          <div className="muted">no decisions logged.</div>
        )}
      </section>
    </div>
  );
}
