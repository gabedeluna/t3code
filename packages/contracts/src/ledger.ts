import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";

/**
 * A thread's ledger: the topics that came up, where each stands, and the questions, decisions
 * and to-dos under each. A scribe model keeps it after every turn, so it never depends on the
 * working model remembering to.
 */
export const LedgerTopicStatus = Schema.Literals([
  "exploring",
  "shaped",
  "chosen",
  "active",
  "review",
  "hold",
  "rejected",
  "done",
]);
export type LedgerTopicStatus = typeof LedgerTopicStatus.Type;

export const LedgerItemKind = Schema.Literals(["question", "decision", "todo"]);
export type LedgerItemKind = typeof LedgerItemKind.Type;

/** open: question or to-do waiting; recorded: a decision that stands. */
export const LedgerItemState = Schema.Literals(["open", "answered", "done", "dropped", "recorded"]);
export type LedgerItemState = typeof LedgerItemState.Type;

export const LedgerItemOwner = Schema.Literals(["claude", "user"]);
export type LedgerItemOwner = typeof LedgerItemOwner.Type;

export const LedgerItem = Schema.Struct({
  id: Schema.String,
  kind: LedgerItemKind,
  state: LedgerItemState,
  text: Schema.String,
  owner: Schema.optionalKey(LedgerItemOwner),
  /** The answer Claude recommended, on a question. */
  rec: Schema.optionalKey(Schema.String),
  /** What settled it, once closed. */
  note: Schema.optionalKey(Schema.String),
  turn: NonNegativeInt,
  closedTurn: Schema.optionalKey(NonNegativeInt),
});
export type LedgerItem = typeof LedgerItem.Type;

export const LedgerTopic = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  status: LedgerTopicStatus,
  turn: NonNegativeInt,
  items: Schema.Array(LedgerItem),
});
export type LedgerTopic = typeof LedgerTopic.Type;

/** One step of the working agent's own task list, mirrored as it changes during a turn. */
export const LedgerLiveTask = Schema.Struct({
  id: Schema.String,
  text: Schema.String,
  status: Schema.Literals(["pending", "in_progress", "completed"]),
});
export type LedgerLiveTask = typeof LedgerLiveTask.Type;

export const LedgerDocument = Schema.Struct({
  threadId: ThreadId,
  /** Off by default: in a thread it is off for, the scribe never runs and nothing is mirrored. */
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  topics: Schema.Array(LedgerTopic),
  /** Next number per id prefix: T (topic), q, d, t. */
  next: Schema.Record(Schema.String, NonNegativeInt),
  /** Turns the scribe has read so far; the next turn is this plus one. */
  turns: NonNegativeInt,
  /** The turn the last cleanup sweep ran after. */
  sweptTurn: NonNegativeInt,
  liveTasks: Schema.Array(LedgerLiveTask).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  /** What the scribe's model calls have cost this thread so far, in US dollars. */
  costUsd: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** The last run the scribe read, so the repeated updates of a finished run are read once. */
  lastRunId: Schema.optionalKey(Schema.String),
  /** When it was last switched on: a restart's catch-up never reads a run that ended before. */
  enabledAt: Schema.optionalKey(IsoDateTime),
  /** Runs that ended while the server was down, beyond what the restart's catch-up reads: never read. */
  missedTurns: Schema.optionalKey(NonNegativeInt),
  /** Why the last scribe call failed; cleared by the next one that succeeds. */
  lastError: Schema.optionalKey(Schema.String),
  /** A scribe call is in flight. Never stored. */
  scribing: Schema.optionalKey(Schema.Boolean),
  updatedAt: IsoDateTime,
});
export type LedgerDocument = typeof LedgerDocument.Type;

export const ThreadLedgerSubscribeInput = Schema.Struct({ threadId: ThreadId });
export type ThreadLedgerSubscribeInput = typeof ThreadLedgerSubscribeInput.Type;

export const ThreadLedgerSetEnabledInput = Schema.Struct({
  threadId: ThreadId,
  enabled: Schema.Boolean,
});
export type ThreadLedgerSetEnabledInput = typeof ThreadLedgerSetEnabledInput.Type;

/** Where a worker stands for the user: its runtime state, read the way the sidebar reads it. */
export const LedgerWorkerState = Schema.Literals([
  "approval",
  "input",
  "review",
  "working",
  "failed",
  "done",
  "idle",
]);
export type LedgerWorkerState = typeof LedgerWorkerState.Type;

/** needs-you: something only the user can unblock; settled: the user put the thread away. */
export const LedgerWorkerGroup = Schema.Literals(["needs-you", "working", "quiet", "settled"]);
export type LedgerWorkerGroup = typeof LedgerWorkerGroup.Type;

/** An open question, or a to-do that is the user's, from a worker's ledger. */
export const LedgerWorkerNeed = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["question", "todo"]),
  text: Schema.String,
  rec: Schema.optionalKey(Schema.String),
  topic: Schema.String,
});
export type LedgerWorkerNeed = typeof LedgerWorkerNeed.Type;

export const LedgerWorker = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  state: LedgerWorkerState,
  group: LedgerWorkerGroup,
  ledgerEnabled: Schema.Boolean,
  /** The first few; `needCount` counts them all. */
  needs: Schema.Array(LedgerWorkerNeed),
  needCount: NonNegativeInt,
  topics: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, status: LedgerTopicStatus }),
  ),
  /** The next open to-do that is Claude's. */
  nextStep: Schema.optionalKey(Schema.String),
  tasks: Schema.optionalKey(
    Schema.Struct({
      done: NonNegativeInt,
      total: NonNegativeInt,
      current: Schema.optionalKey(Schema.String),
    }),
  ),
  /** Why the last turn failed, on a failed worker. */
  lastError: Schema.optionalKey(Schema.String),
});
export type LedgerWorker = typeof LedgerWorker.Type;

/** The threads a thread launched (its workers), each as its ledger and the sidebar see it. */
export const ThreadWorkers = Schema.Struct({
  threadId: ThreadId,
  workers: Schema.Array(LedgerWorker),
});
export type ThreadWorkers = typeof ThreadWorkers.Type;

export const ThreadWorkersSubscribeInput = Schema.Struct({ threadId: ThreadId });
export type ThreadWorkersSubscribeInput = typeof ThreadWorkersSubscribeInput.Type;
