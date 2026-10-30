import type { LedgerWorker, LedgerWorkerGroup, LedgerWorkerState } from "@t3tools/contracts";

import { TOPIC_STATUS_LABELS } from "./ledger.logic";

export const WORKER_STATE_LABELS: Readonly<Record<LedgerWorkerState, string>> = {
  approval: "Approval",
  input: "Input",
  review: "Review",
  working: "Working",
  failed: "Failed",
  done: "Done",
  idle: "Idle",
};

/** The sidebar's status colours, as the ledger's tokens: approval amber, input indigo, work blue. */
export function workerStateToneClass(state: LedgerWorkerState): string {
  switch (state) {
    case "approval":
    case "review":
      return "text-warning-foreground";
    case "input":
      return "text-question-foreground";
    case "working":
      return "text-info-foreground";
    case "failed":
      return "text-destructive-foreground";
    case "done":
      return "text-success-foreground";
    case "idle":
      return "text-muted-foreground";
  }
}

const GROUPS: ReadonlyArray<{ readonly group: LedgerWorkerGroup; readonly label: string }> = [
  { group: "needs-you", label: "Needs you" },
  { group: "working", label: "Working" },
  { group: "quiet", label: "Quiet" },
  { group: "settled", label: "Settled" },
];

export interface WorkerGroup {
  readonly group: LedgerWorkerGroup;
  readonly label: string;
  readonly workers: ReadonlyArray<LedgerWorker>;
}

/** The groups that have workers, in the order the view shows them. */
export function workerGroups(workers: ReadonlyArray<LedgerWorker>): ReadonlyArray<WorkerGroup> {
  return GROUPS.map(({ group, label }) => ({
    group,
    label,
    workers: workers.filter((worker) => worker.group === group),
  })).filter((entry) => entry.workers.length > 0);
}

export function workersSubtitle(count: number): string {
  return `${count} worker${count === 1 ? "" : "s"} · from their ledgers`;
}

const showsNeed = (worker: LedgerWorker) => worker.group === "needs-you" && worker.needs.length > 0;

/** The row's main line: what waits on the user, else the topic under way. */
export function workerLine(worker: LedgerWorker): string {
  const [need] = worker.needs;
  if (need !== undefined && showsNeed(worker)) return need.text;
  if (worker.state === "failed") return worker.lastError ?? "The last turn failed";
  if (worker.state === "approval") return "Waiting for your approval";
  if (worker.state === "input") return "Waiting for your answer";
  // With its ledger off there's nothing to add to the state beside the title.
  if (!worker.ledgerEnabled) return "";
  const topic =
    worker.state === "review"
      ? (worker.topics.find((candidate) => candidate.status === "review") ?? worker.topics[0])
      : worker.topics[0];
  if (topic !== undefined) return topic.name;
  return worker.tasks?.current ?? (worker.state === "working" ? "Working" : "Nothing open");
}

/** The row's meta line: where the need comes from, or the next step and task progress. */
export function workerMeta(worker: LedgerWorker): string {
  if (!worker.ledgerEnabled) return "Ledger off";
  const parts: string[] = [];
  const [need] = worker.needs;
  if (need !== undefined && showsNeed(worker)) {
    parts.push(need.topic);
    if (need.kind === "question" && need.rec) parts.push(`Claude recommends: ${need.rec}`);
    if (need.kind === "todo") parts.push("your check");
    if (worker.needCount > 1) parts.push(`${worker.needCount - 1} more for you`);
    return parts.join(" · ");
  }
  if (worker.nextStep) parts.push(`Next: ${worker.nextStep}`);
  if (worker.tasks) parts.push(`${worker.tasks.done} of ${worker.tasks.total} to-dos done`);
  if (parts.length === 0) {
    const [topic] = worker.topics;
    if (topic !== undefined) parts.push(TOPIC_STATUS_LABELS[topic.status]);
  }
  return parts.join(" · ");
}
