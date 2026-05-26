/**
 * JobStatus lifecycle (module 04, FR-8): per-node states, overall progress, cost,
 * and the overall state machine. The tracker is the single source of truth the
 * engine snapshots onto the `job.status.changed` topic.
 */
import type { JobStatus, PipelineSpec } from "@gentech/contracts";

type State = JobStatus["state"];
type NodeState = JobStatus["nodeStates"][string];

export class JobTracker {
  private state: State = "queued";
  private readonly nodeStates: Record<string, NodeState> = {};
  private costSoFar = 0;
  private startedAt?: string;
  private endedAt?: string;
  /** completed (nodeId,segment) units / total — drives the 0..1 progress bar. */
  private completedUnits = 0;

  constructor(
    readonly jobId: string,
    private readonly spec: PipelineSpec,
    private readonly totalUnits: number,
    private readonly now: () => string,
  ) {
    for (const n of spec.nodes) this.nodeStates[n.nodeId] = "pending";
  }

  start(): void {
    this.state = "running";
    this.startedAt = this.now();
  }

  setNode(nodeId: string, s: NodeState): void {
    this.nodeStates[nodeId] = s;
  }

  nodeState(nodeId: string): NodeState | undefined {
    return this.nodeStates[nodeId];
  }

  unitDone(): void {
    this.completedUnits += 1;
  }

  addCost(credits: number): void {
    this.costSoFar += credits;
  }

  /** Mark the job degraded (FR-6) without ending it. */
  degrade(): void {
    if (this.state === "running") this.state = "degraded";
  }

  finish(): void {
    const states = Object.values(this.nodeStates);
    const anyFailed = states.includes("failed");
    const allDoneOrSkipped = states.every((s) => s === "done" || s === "skipped");
    if (anyFailed && !states.includes("done")) this.state = "failed";
    else if (anyFailed || this.state === "degraded") this.state = "degraded";
    else if (allDoneOrSkipped) this.state = "succeeded";
    this.endedAt = this.now();
  }

  cancel(): void {
    this.state = "cancelled";
    this.endedAt = this.now();
  }

  get current(): State {
    return this.state;
  }

  snapshot(): JobStatus {
    const progress = this.totalUnits === 0 ? 1 : Math.min(1, this.completedUnits / this.totalUnits);
    return {
      jobId: this.jobId,
      pipelineId: this.spec.pipelineId,
      tenantId: this.spec.tenantId,
      state: this.state,
      nodeStates: { ...this.nodeStates },
      progress: Number(progress.toFixed(4)),
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
      ...(this.endedAt ? { endedAt: this.endedAt } : {}),
      costSoFar: Math.round(this.costSoFar),
    };
  }
}
