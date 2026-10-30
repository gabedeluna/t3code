import type {
  LedgerDocument,
  LedgerTopic,
  LedgerWorker,
  LedgerWorkerGroup,
  LedgerWorkerNeed,
  LedgerWorkerState,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

import { liveTopics } from "./ledgerDocument.ts";

/** Needs a worker row carries; the rest are counted. */
const NEEDS_SHOWN = 3;
const TEXT_LIMIT = 120;

export type WorkerShell = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "title"
  | "status"
  | "activityRunStatus"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
  | "settledOverride"
  | "lastError"
>;

type Runtime = "approval" | "input" | "working" | "failed" | "idle";

const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/**
 * The thread's runtime as the sidebar reads it (client-runtime's presentThreadShell and
 * resolveSidebarThreadStatus): a request for the user first, then work under way, then a failure.
 * Background work the agent waits on counts as work.
 */
export function workerRuntime(shell: WorkerShell): Runtime {
  const status = shell.activityRunStatus ?? shell.status;
  const request = shell.pendingRuntimeRequest;
  if (request !== null && request.kind !== "user_input" && request.kind !== "auth_refresh") {
    return "approval";
  }
  const running = status === "preparing" || status === "starting" || status === "running";
  if (request?.kind === "user_input" && (request.blocking !== false || !running)) return "input";
  if (ACTIVE.has(status)) return "working";
  if (status === "failed") return "failed";
  if (backgroundWorkHoldsCompletion(shell.pendingBackgroundTasks ?? [])) return "working";
  return "idle";
}

const short = (value: string, limit = TEXT_LIMIT) => {
  const s = value.replace(/\s+/g, " ").trim();
  return s.length <= limit ? s : `${s.slice(0, limit - 1)}…`;
};

/** Open questions and the user's open to-dos, questions first. */
const needsOf = (topics: ReadonlyArray<LedgerTopic>): LedgerWorkerNeed[] => {
  const needs = topics.flatMap((topic) =>
    topic.items.flatMap((item): LedgerWorkerNeed[] =>
      item.state === "open" &&
      (item.kind === "question" || (item.kind === "todo" && item.owner === "user"))
        ? [
            {
              id: item.id,
              kind: item.kind,
              text: item.text,
              ...(item.rec ? { rec: item.rec } : {}),
              topic: topic.name,
            },
          ]
        : [],
    ),
  );
  return needs.toSorted((a, b) => Number(a.kind === "todo") - Number(b.kind === "todo"));
};

/** Topics under way come first: the next step is most likely there. */
const byActivity = (topics: ReadonlyArray<LedgerTopic>) =>
  topics.toSorted((a, b) => Number(b.status === "active") - Number(a.status === "active"));

const nextStepOf = (topics: ReadonlyArray<LedgerTopic>) =>
  byActivity(topics)
    .flatMap((topic) => topic.items)
    .find((item) => item.kind === "todo" && item.state === "open" && item.owner !== "user")?.text;

const tasksOf = (doc: LedgerDocument) => {
  if (doc.liveTasks.length === 0) return undefined;
  const current = doc.liveTasks.find((task) => task.status === "in_progress")?.text;
  return {
    done: doc.liveTasks.filter((task) => task.status === "completed").length,
    total: doc.liveTasks.length,
    ...(current === undefined ? {} : { current }),
  };
};

const groupOf = (
  runtime: Runtime,
  state: LedgerWorkerState,
  settled: boolean,
): LedgerWorkerGroup => {
  // A settled thread stays put away unless its run stops to ask the user something.
  if (runtime === "approval" || runtime === "input") return "needs-you";
  if (settled) return "settled";
  if (state === "input" || state === "review" || state === "failed") return "needs-you";
  return state === "working" ? "working" : "quiet";
};

/** One worker as the Director's workers view shows it: its runtime, then what its ledger says. */
export function workerOf(shell: WorkerShell, doc: LedgerDocument): LedgerWorker {
  const runtime = workerRuntime(shell);
  const topics = doc.enabled ? liveTopics(doc) : [];
  const needs = needsOf(topics);
  const inReview = topics.some((topic) => topic.status === "review");
  const state: LedgerWorkerState =
    runtime !== "idle"
      ? runtime
      : needs.some((need) => need.kind === "question")
        ? "input"
        : needs.length > 0 || inReview
          ? "review"
          : // Done as the sidebar says it: the last turn finished and nothing is left open.
            topics.length === 0 &&
              (shell.status === "completed" || (doc.enabled && doc.topics.length > 0))
            ? "done"
            : "idle";
  const nextStep = nextStepOf(topics);
  const tasks = doc.enabled ? tasksOf(doc) : undefined;
  return {
    threadId: shell.id,
    title: shell.title,
    state,
    group: groupOf(runtime, state, shell.settledOverride === "settled"),
    ledgerEnabled: doc.enabled,
    needs: needs.slice(0, NEEDS_SHOWN),
    needCount: needs.length,
    topics: byActivity(topics).map(({ id, name, status }) => ({ id, name, status })),
    ...(nextStep === undefined ? {} : { nextStep }),
    ...(tasks === undefined ? {} : { tasks }),
    ...(runtime === "failed" && shell.lastError ? { lastError: shell.lastError } : {}),
  };
}

const GROUPS: ReadonlyArray<{ readonly group: LedgerWorkerGroup; readonly label: string }> = [
  { group: "needs-you", label: "Needs you" },
  { group: "working", label: "Working" },
  { group: "quiet", label: "Quiet" },
  { group: "settled", label: "Settled" },
];

export const groupWorkers = (workers: ReadonlyArray<LedgerWorker>) =>
  GROUPS.map(({ group, label }) => ({
    group,
    label,
    workers: workers.filter((worker) => worker.group === group),
  })).filter((entry) => entry.workers.length > 0);

const needLine = (need: LedgerWorkerNeed) =>
  need.kind === "question"
    ? `question ${need.id} (${short(need.topic, 40)}): ${short(need.text)}${
        need.rec ? ` Claude recommends: ${short(need.rec, 80)}` : ""
      }`
    : `to-do ${need.id} for the user (${short(need.topic, 40)}): ${short(need.text)}`;

/** The worker's one detail line, or none when there is nothing to say. */
const detailOf = (worker: LedgerWorker): string | undefined => {
  if (!worker.ledgerEnabled) {
    return worker.state === "failed" && worker.lastError
      ? `failed: ${short(worker.lastError)}; ledger off`
      : "ledger off";
  }
  const parts: string[] = [];
  const [first] = worker.needs;
  if (first !== undefined && worker.group === "needs-you") {
    parts.push(needLine(first));
    if (worker.needCount > 1) parts.push(`+${worker.needCount - 1} more`);
  } else if (worker.lastError) {
    parts.push(`failed: ${short(worker.lastError)}`);
  }
  const [topic] = worker.topics;
  if (topic !== undefined && parts.length === 0) {
    parts.push(`${topic.id} ${short(topic.name, 60)} [${topic.status}]`);
  }
  if (worker.nextStep) parts.push(`next: ${short(worker.nextStep, 80)}`);
  if (worker.tasks) parts.push(`tasks ${worker.tasks.done}/${worker.tasks.total}`);
  return parts.length === 0 ? undefined : parts.join("; ");
};

/**
 * The Director's rollup of its workers as text: one short block per worker, grouped, settled ones
 * as a list of titles. Every worker carries its thread id, for t3_thread_send or t3_ledger_read.
 */
export function renderWorkers(title: string, workers: ReadonlyArray<LedgerWorker>): string {
  if (workers.length === 0) {
    return `${title} has launched no workers (threads it started with t3_thread_launch).`;
  }
  const lines = [`Workers of ${title}: ${workers.length}, from their ledgers.`];
  for (const { group, label, workers: members } of groupWorkers(workers)) {
    if (group === "settled") {
      lines.push(
        `${label} (${members.length}): ${members.map((worker) => short(worker.title, 60)).join("; ")}`,
      );
      continue;
    }
    lines.push(`${label} (${members.length}):`);
    for (const worker of members) {
      lines.push(`- ${short(worker.title, 60)} [${worker.state}] ${worker.threadId}`);
      const detail = detailOf(worker);
      if (detail !== undefined) lines.push(`  ${detail}`);
    }
  }
  return lines.join("\n");
}
