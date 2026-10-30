import * as NodeServices from "@effect/platform-node/NodeServices";
import { type OrchestrationV2ThreadShell, ThreadId, type ThreadWorkers } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { at } from "./ledger.testkit.ts";
import * as LedgerLaunchers from "./LedgerLaunchers.ts";
import * as LedgerStore from "./LedgerStore.ts";
import * as LedgerWorkers from "./LedgerWorkers.ts";

const director = ThreadId.make("thread:director");
const first = ThreadId.make("thread:first");
const gone = ThreadId.make("thread:gone");
const second = ThreadId.make("thread:second");

const shells = new Map<ThreadId, Partial<OrchestrationV2ThreadShell>>([
  [first, { title: "Hit reactions", status: "running" }],
  [gone, { title: "Deleted", status: "idle", deletedAt: at }],
  [second, { title: "Stone textures", status: "idle" }],
]);

const layer = LedgerWorkers.layer.pipe(
  Layer.provideMerge(Layer.merge(LedgerStore.layer, LedgerLaunchers.layer)),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThreadShell: (threadId) => {
          const found = shells.get(threadId);
          return Effect.succeed(
            found === undefined
              ? null
              : ({
                  id: threadId,
                  pendingRuntimeRequest: null,
                  pendingBackgroundTasks: [],
                  settledOverride: null,
                  deletedAt: null,
                  ...found,
                } as OrchestrationV2ThreadShell),
          );
        },
      }),
    ),
  ),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-ledger-workers-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const services = Effect.all({
  workers: LedgerWorkers.LedgerWorkers,
  launchers: LedgerLaunchers.LedgerLaunchers,
  store: LedgerStore.LedgerStore,
});

describe("LedgerWorkers", () => {
  it.effect("rolls up a launcher's workers in launch order, without deleted ones", () =>
    Effect.gen(function* () {
      const { workers, launchers, store } = yield* services;
      yield* launchers.record(director, first);
      yield* launchers.record(director, gone);
      yield* launchers.record(director, second);
      yield* store.setEnabled(second, true);
      const rollup = yield* workers.rollup(director);
      assert.strictEqual(rollup.threadId, director);
      assert.deepStrictEqual(
        rollup.workers.map((worker) => [worker.title, worker.state, worker.ledgerEnabled]),
        [
          ["Hit reactions", "working", false],
          ["Stone textures", "idle", true],
        ],
      );
      assert.deepStrictEqual((yield* workers.rollup(first)).workers, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("streams the rollup again when a worker's ledger changes, and only then", () =>
    Effect.gen(function* () {
      const { workers, launchers, store } = yield* services;
      yield* launchers.record(director, second);
      yield* store.setEnabled(second, true);
      const seen = yield* Queue.unbounded<ThreadWorkers>();
      const fiber = yield* workers.stream(director).pipe(
        Stream.runForEach((rollup) => Queue.offer(seen, rollup)),
        Effect.forkChild,
      );
      const initial = yield* Queue.take(seen);
      assert.strictEqual(initial.workers[0]!.state, "idle");

      // Another thread's ledger moves nothing; the worker's does.
      yield* store.setEnabled(first, true);
      yield* store.update(second, (doc) => ({
        ...doc,
        topics: [
          {
            id: "T1",
            name: "Stone textures",
            status: "active",
            turn: 1,
            items: [{ id: "q1", kind: "question", state: "open", text: "Batch 2?", turn: 1 }],
          },
        ],
      }));
      yield* TestClock.adjust("1 second");
      const changed = yield* Queue.take(seen);
      assert.deepStrictEqual(
        [changed.workers[0]!.state, changed.workers[0]!.group, changed.workers[0]!.needCount],
        ["input", "needs-you", 1],
      );

      // A newly launched worker joins the feed.
      yield* launchers.record(director, first);
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(
        (yield* Queue.take(seen)).workers.map((worker) => worker.title),
        ["Stone textures", "Hit reactions"],
      );
      assert.strictEqual(yield* Queue.size(seen), 0);
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.provide(layer)),
  );
});
