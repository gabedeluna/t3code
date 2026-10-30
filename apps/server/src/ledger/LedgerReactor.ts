import {
  DEFAULT_SERVER_SETTINGS,
  type LedgerDocument,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PlanStep,
  RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { missedRuns } from "./ledgerCatchUp.ts";
import {
  type LedgerDraft,
  applyScribeReply,
  draftOf,
  filedLiveTasks,
  readScribeReply,
} from "./ledgerDocument.ts";
import {
  SWEEP_REPLY_SCHEMA,
  TASK_TOPIC_SCHEMA,
  TASK_TOPIC_SYSTEM,
  TURN_REPLY_SCHEMA,
  scribeSystemPrompt,
  sweepPrompt,
  taskTopicPrompt,
  turnPrompt,
} from "./ledgerPrompts.ts";
import * as LedgerLaunchers from "./LedgerLaunchers.ts";
import * as LedgerStore from "./LedgerStore.ts";
import { isDirectorThread, liveTasksFrom, readTurn } from "./ledgerTurn.ts";
import * as ScribeRunner from "./ScribeRunner.ts";

/**
 * Keeps the ledgers that are switched on: a turn-model call per finished run, a sweep every
 * `ledgerSweepEvery` turns, and a live copy of the agent's task list with no model call.
 * On start it first reads, per thread, the last few runs that ended while the server was down.
 */
export class LedgerReactor extends Context.Service<
  LedgerReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** One event, in the caller's fiber. `start` runs each thread's events one at a time. */
    readonly process: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    /** Reads the runs a thread's ledger missed, oldest first, in the caller's fiber. */
    readonly catchUp: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/ledger/LedgerReactor") {}

/** How long catch-up waits after the live feed starts, so a run ending meanwhile is in one or both. */
const CATCH_UP_DELAY = "1 second";

const SCRIBED_RUN_STATUSES = new Set(["completed", "failed", "interrupted"]);

/** The events the ledger acts on; the rest never reach a thread's queue. */
export const isLedgerEvent = (event: OrchestrationV2DomainEvent) =>
  (event.type === "run.updated" && SCRIBED_RUN_STATUSES.has(event.payload.status)) ||
  (event.type === "turn-item.updated" && event.payload.type === "todo_list") ||
  event.type === "thread.deleted";

const withoutScribing = (doc: LedgerDocument): LedgerDocument => {
  if (doc.scribing === undefined) return doc;
  const { scribing: _scribing, ...rest } = doc;
  return rest;
};

const sameTasks = (a: LedgerDocument["liveTasks"], b: LedgerDocument["liveTasks"]) =>
  sameTaskList(a, b) && a.every((task, i) => task.status === b[i]!.status);

/** The same steps, whatever their progress: a new list is filed under a topic, a tick is not. */
const sameTaskList = (a: LedgerDocument["liveTasks"], b: LedgerDocument["liveTasks"]) =>
  a.length === b.length && a.every((task, i) => task.id === b[i]!.id && task.text === b[i]!.text);

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const store = yield* LedgerStore.LedgerStore;
  const launchers = yield* LedgerLaunchers.LedgerLaunchers;
  const runner = yield* ScribeRunner.ScribeRunner;
  const serverSettings = yield* ServerSettings.ServerSettingsService;

  const settings = serverSettings.getSettings.pipe(
    Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
  );

  /**
   * The only place the scribe's model is called. It rereads the thread's switch first, so no
   * path, however it got here, spends a call on a thread whose ledger is off. None means it is off.
   */
  const callModel = (threadId: ThreadId, call: ScribeRunner.ScribeCall) =>
    store.get(threadId).pipe(
      Effect.flatMap((doc) =>
        doc.enabled
          ? runner.run(call).pipe(Effect.retry({ times: 1 }), Effect.asSome)
          : Effect.succeedNone,
      ),
      Effect.result,
    );

  /** Applies a call's outcome to the ledger as it stands now, unless it was switched off meanwhile. */
  const record = (
    threadId: ThreadId,
    outcome: Result.Result<
      Option.Option<ScribeRunner.ScribeResult>,
      ScribeRunner.ScribeRunnerError
    >,
    apply: (draft: LedgerDraft, reply: ReturnType<typeof readScribeReply>) => void,
    after: (draft: LedgerDraft) => void,
  ) =>
    store.update(threadId, (current) => {
      if (!current.enabled) return withoutScribing(current);
      const draft = draftOf(current);
      if (Result.isFailure(outcome)) {
        draft.lastError = outcome.failure.detail;
      } else if (Option.isSome(outcome.success)) {
        apply(draft, readScribeReply(outcome.success.value.output));
        draft.costUsd += outcome.success.value.costUsd;
        delete draft.lastError;
      }
      after(draft);
      return draft as LedgerDocument;
    });

  const readRun = Effect.fnUntraced(function* (
    threadId: ThreadId,
    runId: RunId,
    doc: LedgerDocument,
  ) {
    const lastRunId = doc.lastRunId === undefined ? undefined : RunId.make(doc.lastRunId);
    const records = yield* projections.getThreadRecords(threadId, ["runs", "turnItems"], {
      runIds: lastRunId === undefined ? [runId] : [runId, lastRunId],
      turnItemRunIds: [runId],
    });
    const { thread } = records;
    if (thread.deletedAt !== null || thread.lineage.relationshipToParent === "subagent") {
      return undefined;
    }
    const run = records.runs.find((candidate) => candidate.id === runId);
    const last = records.runs.find((candidate) => candidate.id === lastRunId);
    // A late update of a run older than the last one read.
    if (run === undefined || (last !== undefined && last.ordinal >= run.ordinal)) return undefined;
    const message = yield* projections.getRunMessage(threadId, runId);
    const sender =
      message?.senderThreadId === undefined
        ? undefined
        : yield* projections.getThread(message.senderThreadId).pipe(
            Effect.map((from) => ({ title: from.title, director: isDirectorThread(from) })),
            Effect.orElseSucceed(() => undefined),
          );
    return { read: readTurn({ number: doc.turns + 1, message, items: records.turnItems, sender }) };
  });

  const sweep = Effect.fnUntraced(function* (
    threadId: ThreadId,
    every: number,
    user: string,
    model: string,
  ) {
    const doc = yield* store.get(threadId);
    const recent = yield* store.recentTurns(threadId);
    const outcome = yield* callModel(threadId, {
      model,
      systemPrompt: scribeSystemPrompt(user),
      prompt: sweepPrompt(doc, recent.slice(-every), user),
      schema: SWEEP_REPLY_SCHEMA,
    });
    yield* record(
      threadId,
      outcome,
      (draft, reply) =>
        applyScribeReply(draft, reply, { turn: draft.turns, sweep: true, source: "user" }),
      // A failed sweep waits for the next cadence rather than retrying on every turn.
      (draft) => {
        draft.sweptTurn = draft.turns;
        delete draft.scribing;
      },
    );
  });

  const scribe = Effect.fnUntraced(function* (threadId: ThreadId, runId: RunId) {
    const doc = yield* store.get(threadId);
    if (!doc.enabled || doc.lastRunId === runId) return;
    const found = yield* readRun(threadId, runId, doc);
    if (found === undefined) return;
    if (found.read === undefined) {
      yield* store.update(threadId, (current) => ({ ...current, lastRunId: runId }));
      return;
    }
    const { turn, source } = found.read;
    const config = yield* settings;
    const every = config.ledgerSweepEvery;
    yield* store.update(threadId, (current) =>
      current.enabled ? { ...current, scribing: true } : current,
    );
    const outcome = yield* callModel(threadId, {
      model: config.ledgerTurnModel,
      systemPrompt: scribeSystemPrompt(config.ledgerUserName),
      prompt: turnPrompt(doc, turn),
      schema: TURN_REPLY_SCHEMA,
    });
    // Kept even when the call failed, so the next sweep still reads this turn.
    yield* store.appendTurn(threadId, turn, every);
    const after = yield* record(
      threadId,
      outcome,
      (draft, reply) => applyScribeReply(draft, reply, { turn: turn.number, sweep: false, source }),
      (draft) => {
        draft.turns = turn.number;
        draft.lastRunId = runId;
        if (draft.turns - draft.sweptTurn < every) delete draft.scribing;
      },
    );
    if (after.enabled && after.turns - after.sweptTurn >= every) {
      yield* sweep(threadId, every, config.ledgerUserName, config.ledgerSweepModel);
    }
  });

  // A long turn would otherwise show its work under no topic, and that topic's old status,
  // until the scribe reads the finished turn.
  const fileTasks = Effect.fnUntraced(function* (
    threadId: ThreadId,
    runId: RunId | null,
    tasks: LedgerDocument["liveTasks"],
  ) {
    const doc = yield* store.get(threadId);
    const topics = doc.topics.filter((t) => t.status !== "done" && t.status !== "rejected");
    if (topics.length === 0) return;
    const message =
      runId === null
        ? undefined
        : yield* projections
            .getRunMessage(threadId, runId)
            .pipe(Effect.orElseSucceed(() => undefined));
    const config = yield* settings;
    const outcome = yield* callModel(threadId, {
      model: config.ledgerTurnModel,
      systemPrompt: TASK_TOPIC_SYSTEM,
      prompt: taskTopicPrompt(topics, message?.text, tasks),
      schema: TASK_TOPIC_SCHEMA,
    });
    if (Result.isFailure(outcome) || Option.isNone(outcome.success)) return;
    const { output, costUsd } = outcome.success.value;
    const topicId =
      typeof output === "object" && output !== null && "topic" in output
        ? String(output.topic)
        : "";
    yield* store.update(threadId, (current) => {
      if (!current.enabled) return current;
      const paid = { ...current, costUsd: current.costUsd + costUsd };
      return sameTaskList(current.liveTasks, tasks) ? filedLiveTasks(paid, topicId) : paid;
    });
  });

  const mirrorTasks = Effect.fnUntraced(function* (
    threadId: ThreadId,
    runId: RunId | null,
    steps: ReadonlyArray<OrchestrationV2PlanStep>,
  ) {
    const tasks = liveTasksFrom(steps);
    const before = yield* store.get(threadId);
    const after = yield* store.update(threadId, (current) => {
      if (!current.enabled || sameTasks(current.liveTasks, tasks)) return current;
      if (sameTaskList(current.liveTasks, tasks)) return { ...current, liveTasks: tasks };
      const { liveTopic: _filed, ...unfiled } = current;
      return { ...unfiled, liveTasks: tasks };
    });
    if (after.enabled && tasks.length > 0 && !sameTaskList(before.liveTasks, tasks)) {
      yield* fileTasks(threadId, runId, tasks);
    }
  });

  const scribeRun = (threadId: ThreadId, runId: RunId) =>
    scribe(threadId, runId).pipe(Effect.ensuring(store.update(threadId, withoutScribing)));

  // The live path for each run, so the same gate: every model call rereads the thread's switch.
  const catchUp: LedgerReactor["Service"]["catchUp"] = Effect.fn("LedgerReactor.catchUp")(
    function* (threadId) {
      const doc = yield* store.get(threadId);
      if (!doc.enabled) return;
      const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
      const missed = missedRuns(doc, runs);
      if (missed.skipped > 0) {
        yield* Effect.logInfo("a thread ledger skips runs that ended while the server was down", {
          threadId,
          skipped: missed.skipped,
        });
        yield* store.update(threadId, (current) =>
          current.enabled
            ? { ...current, missedTurns: (current.missedTurns ?? 0) + missed.skipped }
            : current,
        );
      }
      for (const runId of missed.runIds) {
        yield* scribeRun(threadId, runId);
      }
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("catching up a thread ledger failed", { threadId, cause }),
        ),
      ),
  );

  const process: LedgerReactor["Service"]["process"] = (event) => {
    const work =
      event.type === "run.updated" && SCRIBED_RUN_STATUSES.has(event.payload.status)
        ? scribeRun(event.threadId, event.payload.id)
        : event.type === "turn-item.updated" && event.payload.type === "todo_list"
          ? mirrorTasks(event.threadId, event.payload.runId, event.payload.steps)
          : event.type === "thread.deleted"
            ? store.remove(event.threadId).pipe(Effect.andThen(launchers.forget(event.threadId)))
            : Effect.void;
    return work.pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("keeping a thread ledger failed", { threadId: event.threadId, cause }),
      ),
    );
  };

  // A queue per thread: its work runs in order, and a slow model call holds up only its thread.
  // A thread's catch-up goes in first, so its live runs queue behind the ones it missed.
  const start: LedgerReactor["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const lanes = new Map<ThreadId, Queue.Queue<Effect.Effect<void>>>();
        const enqueue = Effect.fnUntraced(function* (
          threadId: ThreadId,
          work: Effect.Effect<void>,
        ) {
          let lane = lanes.get(threadId);
          if (lane === undefined) {
            lane = yield* Queue.unbounded<Effect.Effect<void>>();
            lanes.set(threadId, lane);
            yield* Queue.take(lane).pipe(Effect.flatten, Effect.forever, Effect.forkIn(scope));
          }
          yield* Queue.offer(lane, work);
        });
        const live = yield* Deferred.make<void>();
        for (const threadId of yield* store.enabledThreads()) {
          yield* enqueue(
            threadId,
            Deferred.await(live).pipe(
              Effect.andThen(Effect.sleep(CATCH_UP_DELAY)),
              Effect.andThen(catchUp(threadId)),
            ),
          );
        }
        yield* Stream.runForEach(
          engine.streamDomainEvents.pipe(
            Stream.onStart(Deferred.succeed(live, undefined)),
            Stream.filter(isLedgerEvent),
          ),
          (event) => enqueue(event.threadId, process(event)),
        );
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("ledger event stream failed", { cause })),
      ),
    );

  return LedgerReactor.of({ start, process, catchUp });
});

export const layer = Layer.effect(LedgerReactor, make);
