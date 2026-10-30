import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  PlanId,
  ProviderInstanceId,
  type RunId,
  ThreadId,
  EventId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import { at, item, ledgerThreadId, message, run, runIdOf, thread } from "./ledger.testkit.ts";
import { SWEEP_REPLY_SCHEMA } from "./ledgerPrompts.ts";
import * as LedgerLaunchers from "./LedgerLaunchers.ts";
import * as LedgerReactor from "./LedgerReactor.ts";
import * as LedgerStore from "./LedgerStore.ts";
import * as ScribeRunner from "./ScribeRunner.ts";

interface World {
  thread: OrchestrationV2AppThread;
  readonly messages: Map<RunId, OrchestrationV2ConversationMessage>;
  readonly items: OrchestrationV2TurnItem[];
  readonly threads: Map<ThreadId, OrchestrationV2AppThread>;
  /** Every run of the thread, as a restart's catch-up lists them. */
  runs: OrchestrationV2Run[];
}

interface Harness {
  readonly world: World;
  readonly calls: ScribeRunner.ScribeCall[];
  /** What the fake model replies to a turn call; sweeps get an empty sweep reply. */
  turnReply: (call: ScribeRunner.ScribeCall) => unknown;
  /** Runs inside each model call, before it answers. */
  during: Effect.Effect<void>;
  failing: boolean;
  /** The orchestrator's live feed. */
  live: Stream.Stream<OrchestrationV2DomainEvent>;
}

const harness = (): Harness => ({
  world: { thread: thread(), messages: new Map(), items: [], threads: new Map(), runs: [] },
  calls: [],
  turnReply: () => ({ closes: [], statuses: [], new_topics: [], adds: [], revisions: [] }),
  during: Effect.void,
  failing: false,
  live: Stream.never,
});

const layerFor = (h: Harness, settings: Parameters<typeof ServerSettings.layerTest>[0] = {}) =>
  LedgerReactor.layer.pipe(
    Layer.provideMerge(Layer.merge(LedgerStore.layer, LedgerLaunchers.layer)),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: h.live }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: (_threadId, _fields, filter) =>
            Effect.succeed({
              thread: h.world.thread,
              runs:
                filter?.runIds === undefined
                  ? h.world.runs
                  : filter.runIds.map((id) => run(Number(String(id).split("-").at(-1)))),
              turnItems: h.world.items.filter((i) => filter?.turnItemRunIds?.includes(i.runId)),
            } as unknown as OrchestrationV2ThreadProjection),
          getRunMessage: (_threadId, runId) => Effect.succeed(h.world.messages.get(runId)),
          getThread: (threadId) => {
            const found = h.world.threads.get(threadId);
            return found === undefined ? Effect.die("no such thread") : Effect.succeed(found);
          },
        }),
        Layer.succeed(ScribeRunner.ScribeRunner, {
          run: (call) =>
            Effect.gen(function* () {
              h.calls.push(call);
              yield* h.during;
              if (h.failing) return yield* new ScribeRunner.ScribeRunnerError({ detail: "boom" });
              return {
                output:
                  call.schema === SWEEP_REPLY_SCHEMA
                    ? { checks: [], statuses: [], revisions: [] }
                    : h.turnReply(call),
                costUsd: 0.01,
              };
            }),
        }),
        ServerSettings.layerTest(settings),
      ),
    ),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-ledger-reactor-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const finished = (n: number, status: "completed" | "failed" | "interrupted" = "completed") =>
  ({
    id: EventId.make(`event:ledger-${n}`),
    type: "run.updated",
    threadId: ledgerThreadId,
    occurredAt: at,
    payload: run(n, status),
  }) as unknown as OrchestrationV2DomainEvent;

/** A run that ended after the test switched its ledger on. */
const ended = (n: number): OrchestrationV2Run => ({
  ...run(n),
  completedAt: DateTime.makeUnsafe("2100-01-01T00:00:00.000Z"),
});

const addTurn = (h: Harness, n: number, text = `Turn ${n} message`) => {
  h.world.messages.set(runIdOf(n), message(n, text));
  h.world.items.push(
    item(n, 1, {
      type: "assistant_message",
      messageId: MessageId.make(`reply-${n}`),
      text: `Reply ${n}`,
      streaming: false,
    }),
  );
};

const services = Effect.all({
  reactor: LedgerReactor.LedgerReactor,
  store: LedgerStore.LedgerStore,
});

describe("LedgerReactor", () => {
  it.effect("makes no model call for a thread whose ledger is off", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { reactor, store } = yield* services;
      addTurn(h, 1);
      yield* reactor.process(finished(1));
      assert.strictEqual(h.calls.length, 0);
      assert.strictEqual((yield* store.get(ledgerThreadId)).turns, 0);
    }).pipe(Effect.provide(layerFor(h)));
  });

  it.effect("makes no model call for a delegated child thread", () => {
    const h = harness();
    h.world.thread = thread({
      lineage: {
        rootThreadId: ThreadId.make("thread:parent"),
        parentThreadId: ThreadId.make("thread:parent"),
        relationshipToParent: "subagent",
      },
    });
    return Effect.gen(function* () {
      const { reactor, store } = yield* services;
      yield* store.setEnabled(ledgerThreadId, true);
      addTurn(h, 1);
      yield* reactor.process(finished(1));
      assert.strictEqual(h.calls.length, 0);
    }).pipe(Effect.provide(layerFor(h)));
  });

  it.effect("reads each run once, however often it is updated", () => {
    const h = harness();
    h.turnReply = (call) => ({
      closes: [],
      statuses: [],
      // Names far enough apart that the twin-topic guard keeps both.
      new_topics: [
        {
          name: /TURN 1\b/.test(call.prompt) ? "Stone textures" : "Night moonlight",
          status: "active",
        },
      ],
      adds: [],
      revisions: [],
    });
    return Effect.gen(function* () {
      const { reactor, store } = yield* services;
      yield* store.setEnabled(ledgerThreadId, true);
      addTurn(h, 1);
      addTurn(h, 2);
      yield* reactor.process(finished(1));
      yield* reactor.process(finished(1));
      yield* reactor.process(finished(1, "failed"));
      assert.strictEqual(h.calls.length, 1);
      yield* reactor.process(finished(2));
      // A late update of an older run.
      yield* reactor.process(finished(1));
      assert.strictEqual(h.calls.length, 2);
      const doc = yield* store.get(ledgerThreadId);
      assert.strictEqual(doc.turns, 2);
      assert.strictEqual(doc.lastRunId, runIdOf(2));
      assert.deepStrictEqual(
        doc.topics.map((t) => t.name),
        ["Stone textures", "Night moonlight"],
      );
      assert.closeTo(doc.costUsd, 0.02, 1e-9);
      assert.isUndefined(doc.scribing);
      assert.match(h.calls[1]!.prompt, /Reply 2/);
      assert.strictEqual(h.calls[0]!.model, "haiku");
    }).pipe(Effect.provide(layerFor(h)));
  });

  it.effect("sweeps with the sweep model exactly every N turns", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { reactor, store } = yield* services;
      yield* store.setEnabled(ledgerThreadId, true);
      for (let n = 1; n <= 7; n++) {
        addTurn(h, n);
        yield* reactor.process(finished(n));
      }
      assert.deepStrictEqual(
        h.calls.map((call) => call.model),
        [
          "turn-m",
          "turn-m",
          "turn-m",
          "sweep-m",
          "turn-m",
          "turn-m",
          "turn-m",
          "sweep-m",
          "turn-m",
        ],
      );
      const secondSweep = h.calls[7]!.prompt;
      assert.match(secondSweep, /--- Turn 4\n/);
      assert.match(secondSweep, /--- Turn 6\n/);
      assert.notMatch(secondSweep, /--- Turn 3\n/);
      assert.match(h.calls[7]!.systemPrompt, /between Gabe \(the user\)/);
      const doc = yield* store.get(ledgerThreadId);
      assert.strictEqual(doc.turns, 7);
      assert.strictEqual(doc.sweptTurn, 6);
    }).pipe(
      Effect.provide(
        layerFor(h, {
          ledgerTurnModel: "turn-m",
          ledgerSweepModel: "sweep-m",
          ledgerSweepEvery: 3,
          ledgerUserName: "Gabe",
        }),
      ),
    );
  });

  it.effect("retries a failed call once, records the error, and moves on", () => {
    const h = harness();
    h.failing = true;
    return Effect.gen(function* () {
      const { reactor, store } = yield* services;
      yield* store.setEnabled(ledgerThreadId, true);
      addTurn(h, 1);
      yield* reactor.process(finished(1));
      assert.strictEqual(h.calls.length, 2);
      let doc = yield* store.get(ledgerThreadId);
      assert.strictEqual(doc.lastError, "boom");
      assert.strictEqual(doc.turns, 1);
      assert.isUndefined(doc.scribing);
      // The turn is still there for the next sweep.
      assert.strictEqual((yield* store.recentTurns(ledgerThreadId)).length, 1);
      h.failing = false;
      addTurn(h, 2);
      yield* reactor.process(finished(2));
      doc = yield* store.get(ledgerThreadId);
      assert.isUndefined(doc.lastError);
      assert.strictEqual(doc.turns, 2);
    }).pipe(Effect.provide(layerFor(h)));
  });

  it.effect("calls no model once the ledger is switched off, even mid-turn", () => {
    const h = harness();
    return Effect.gen(function* () {
      const { reactor, store } = yield* services;
      yield* store.setEnabled(ledgerThreadId, true);
      h.during = store.setEnabled(ledgerThreadId, false).pipe(Effect.asVoid);
      addTurn(h, 1);
      // A sweep is due after this turn; switching off during the turn call must stop it.
      yield* reactor.process(finished(1));
      assert.strictEqual(h.calls.length, 1);
      const doc = yield* store.get(ledgerThreadId);
      assert.isFalse(doc.enabled);
      assert.strictEqual(doc.turns, 0);
      assert.isUndefined(doc.scribing);
    }).pipe(Effect.provide(layerFor(h, { ledgerSweepEvery: 1 })));
  });

  it.effect("records no decision from another session's report, but does from the Director", () => {
    const h = harness();
    const workerId = ThreadId.make("thread:worker");
    const directorId = ThreadId.make("thread:director");
    h.world.threads.set(workerId, thread({ id: workerId, title: "Worker" }));
    h.world.threads.set(
      directorId,
      thread({
        id: directorId,
        title: "Telify",
        providerInstanceId: ProviderInstanceId.make("claude-director"),
      }),
    );
    h.turnReply = () => ({
      closes: [],
      statuses: [],
      new_topics: [],
      adds: [{ topic: "Shipping", kind: "decision", text: "Ship on Friday" }],
      revisions: [],
    });
    const sent = (n: number, from: ThreadId) => {
      h.world.messages.set(
        runIdOf(n),
        message(n, "Ship on Friday", {
          createdBy: "agent",
          creationSource: "mcp",
          senderThreadId: from,
        }),
      );
    };
    return Effect.gen(function* () {
      const { reactor, store } = yield* services;
      yield* store.setEnabled(ledgerThreadId, true);
      sent(1, workerId);
      yield* reactor.process(finished(1));
      assert.strictEqual((yield* store.get(ledgerThreadId)).topics.length, 0);
      assert.match(h.calls[0]!.prompt, /\[Message from Worker\]/);
      sent(2, directorId);
      yield* reactor.process(finished(2));
      const doc = yield* store.get(ledgerThreadId);
      assert.deepStrictEqual(
        doc.topics.flatMap((t) => t.items.map((i) => i.text)),
        ["Ship on Friday"],
      );
    }).pipe(Effect.provide(layerFor(h)));
  });

  it.effect("catches up on the newest runs it missed, oldest first, and counts the rest", () => {
    const h = harness();
    for (let n = 1; n <= 13; n++) addTurn(h, n);
    h.world.runs = [
      ...Array.from({ length: 13 }, (_, i) => ended(i + 1)),
      { ...run(14, "running"), completedAt: null },
    ];
    return Effect.gen(function* () {
      const { reactor, store } = yield* services;
      yield* reactor.catchUp(ledgerThreadId);
      assert.strictEqual(h.calls.length, 0, "never for a thread whose ledger is off");

      yield* store.setEnabled(ledgerThreadId, true);
      yield* store.update(ledgerThreadId, (doc) => ({ ...doc, lastRunId: runIdOf(2), turns: 2 }));
      yield* reactor.catchUp(ledgerThreadId);
      assert.deepStrictEqual(
        h.calls.map((call) => /Turn (\d+) message/.exec(call.prompt)?.[1]),
        ["6", "7", "8", "9", "10", "11", "12", "13"],
      );
      let doc = yield* store.get(ledgerThreadId);
      assert.strictEqual(doc.missedTurns, 3);
      assert.strictEqual(doc.lastRunId, runIdOf(13));
      assert.strictEqual(doc.turns, 10);

      // Caught up: a second pass reads nothing, and older runs stay unread.
      yield* reactor.catchUp(ledgerThreadId);
      yield* reactor.process(finished(4));
      assert.strictEqual(h.calls.length, 8);
      addTurn(h, 14);
      yield* reactor.process(finished(14));
      doc = yield* store.get(ledgerThreadId);
      assert.strictEqual(doc.lastRunId, runIdOf(14));
      assert.strictEqual(doc.missedTurns, 3);
    }).pipe(Effect.provide(layerFor(h, { ledgerSweepEvery: 100 })));
  });

  // Live clock: catch-up waits a real moment after the live feed starts.
  it.live("on start, reads a thread's missed runs before its live ones", () => {
    const h = harness();
    for (let n = 1; n <= 4; n++) addTurn(h, n);
    h.world.runs = [ended(1), ended(2), ended(3)];
    // Run 4 ends just as the server comes back: its live update arrives before catch-up runs.
    h.live = Stream.make(finished(4)).pipe(Stream.concat(Stream.never));
    return Effect.gen(function* () {
      const { reactor, store } = yield* services;
      yield* store.setEnabled(ledgerThreadId, true);
      yield* store.update(ledgerThreadId, (doc) => ({ ...doc, lastRunId: runIdOf(1) }));
      const third = yield* Deferred.make<void>();
      h.during = Effect.suspend(() =>
        h.calls.length === 3 ? Deferred.succeed(third, undefined) : Effect.succeed(true),
      ).pipe(Effect.asVoid);
      yield* Effect.scoped(
        reactor.start().pipe(Effect.andThen(Deferred.await(third)), Effect.timeout("10 seconds")),
      );
      assert.deepStrictEqual(
        h.calls.map((call) => /Turn (\d+) message/.exec(call.prompt)?.[1]),
        ["2", "3", "4"],
      );
    }).pipe(Effect.provide(layerFor(h, { ledgerSweepEvery: 100 })));
  });

  it.effect("stops catching up once the ledger is switched off", () => {
    const h = harness();
    for (let n = 1; n <= 3; n++) addTurn(h, n);
    h.world.runs = [ended(1), ended(2), ended(3)];
    return Effect.gen(function* () {
      const { reactor, store } = yield* services;
      yield* store.setEnabled(ledgerThreadId, true);
      yield* store.update(ledgerThreadId, (doc) => ({ ...doc, lastRunId: runIdOf(1) }));
      h.during = store.setEnabled(ledgerThreadId, false).pipe(Effect.asVoid);
      yield* reactor.catchUp(ledgerThreadId);
      assert.strictEqual(h.calls.length, 1);
      assert.strictEqual((yield* store.get(ledgerThreadId)).lastRunId, runIdOf(1));
    }).pipe(Effect.provide(layerFor(h, { ledgerSweepEvery: 100 })));
  });

  it.effect("mirrors the agent's task list with no model call, only while on", () => {
    const h = harness();
    const todo = (
      steps: ReadonlyArray<{
        id: string;
        text: string;
        status: "pending" | "running" | "completed";
      }>,
    ) =>
      ({
        id: EventId.make("event:todo"),
        type: "turn-item.updated",
        threadId: ledgerThreadId,
        occurredAt: at,
        payload: item(1, 1, { type: "todo_list", planId: PlanId.make("plan-1"), steps }),
      }) as unknown as OrchestrationV2DomainEvent;
    return Effect.gen(function* () {
      const { reactor, store } = yield* services;
      yield* reactor.process(todo([{ id: "1", text: "Build", status: "running" }]));
      assert.deepStrictEqual((yield* store.get(ledgerThreadId)).liveTasks, []);
      yield* store.setEnabled(ledgerThreadId, true);
      yield* reactor.process(
        todo([
          { id: "1", text: "Build", status: "completed" },
          { id: "2", text: "Test", status: "running" },
        ]),
      );
      assert.deepStrictEqual((yield* store.get(ledgerThreadId)).liveTasks, [
        { id: "1", text: "Build", status: "completed" },
        { id: "2", text: "Test", status: "in_progress" },
      ]);
      assert.strictEqual(h.calls.length, 0);
    }).pipe(Effect.provide(layerFor(h)));
  });
});

describe("isLedgerEvent", () => {
  it("lets through finished runs, task lists and deletions only", () => {
    assert.isTrue(LedgerReactor.isLedgerEvent(finished(1)));
    assert.isTrue(LedgerReactor.isLedgerEvent(finished(1, "interrupted")));
    assert.isFalse(
      LedgerReactor.isLedgerEvent({
        ...finished(1),
        payload: run(1, "running"),
      } as OrchestrationV2DomainEvent),
    );
    assert.isFalse(
      LedgerReactor.isLedgerEvent({
        ...finished(1),
        payload: run(1, "cancelled"),
      } as OrchestrationV2DomainEvent),
    );
  });
});
