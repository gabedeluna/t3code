import * as NodeServices from "@effect/platform-node/NodeServices";
import { type LedgerDocument, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as LedgerStore from "./LedgerStore.ts";

const threadId = ThreadId.make("mcp:abc");

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-ledger-store-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

// Each call builds a new store, as a restarted server would, over the same state directory.
const withStore = <A, E>(use: (store: LedgerStore.LedgerStore["Service"]) => Effect.Effect<A, E>) =>
  Effect.flatMap(LedgerStore.LedgerStore, use).pipe(Effect.provide(LedgerStore.layer));

describe("LedgerStore", () => {
  it.effect(
    "keeps each thread's ledger in its own file across restarts, without the in-flight flag",
    () =>
      Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fresh = yield* withStore((store) => store.get(threadId));
        assert.isFalse(fresh.enabled);
        yield* withStore((store) =>
          store
            .setEnabled(threadId, true)
            .pipe(
              Effect.andThen(
                store.update(threadId, (doc) => ({ ...doc, turns: 3, scribing: true })),
              ),
            ),
        );
        assert.isTrue(yield* fs.exists(path.join(config.stateDir, "ledgers", "mcp%3Aabc.json")));
        const reloaded = yield* withStore((store) => store.get(threadId));
        assert.isTrue(reloaded.enabled);
        assert.strictEqual(reloaded.turns, 3);
        assert.isUndefined(reloaded.scribing);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("never overwrites a ledger file it cannot read", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const other = ThreadId.make("mcp:unreadable");
      // A directory where the file should be: reading fails with an error other than not-found.
      const filePath = path.join(config.stateDir, "ledgers", "mcp%3Aunreadable.json");
      yield* fs.makeDirectory(filePath, { recursive: true });
      const result = yield* withStore((store) => store.setEnabled(other, true));
      assert.isFalse(result.enabled);
      assert.strictEqual((yield* fs.stat(filePath)).type, "Directory");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps only the newest recent turns, cut to what a sweep reads", () =>
    Effect.gen(function* () {
      const turns = yield* withStore((store) =>
        Effect.gen(function* () {
          for (let n = 1; n <= 3; n++) {
            yield* store.appendTurn(
              threadId,
              {
                number: n,
                incoming: "go",
                reply: "x".repeat(5000),
                tools: Array(20).fill("Edited a.ts"),
              },
              2,
            );
          }
          return yield* store.recentTurns(threadId);
        }),
      );
      assert.deepStrictEqual(
        turns.map((t) => t.number),
        [2, 3],
      );
      assert.isBelow(turns[0]!.reply.length, 1600);
      assert.strictEqual(turns[0]!.tools.length, 10);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("removes both files when the thread is deleted", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const doc = yield* withStore((store) =>
        Effect.gen(function* () {
          yield* store.setEnabled(threadId, true);
          yield* store.appendTurn(threadId, { number: 1, incoming: "", reply: "", tools: [] }, 8);
          yield* store.remove(threadId);
          return yield* store.get(threadId);
        }),
      );
      assert.isFalse(doc.enabled);
      assert.deepStrictEqual(yield* fs.readDirectory(`${config.stateDir}/ledgers`), []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("lists the threads whose ledger is on, past sidecars and other files", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const on = ThreadId.make("thread:on");
      const off = ThreadId.make("thread:off");
      yield* withStore((store) =>
        Effect.gen(function* () {
          yield* store.setEnabled(on, true);
          yield* store.setShown(on, { topics: {}, items: {} });
          yield* store.appendTurn(on, { number: 1, incoming: "", reply: "", tools: [] }, 8);
          yield* store.setEnabled(off, true);
          yield* store.setEnabled(off, false);
        }),
      );
      yield* fs.writeFileString(`${config.stateDir}/ledgers/launchers.json`, "{}");
      // A restarted server reads them from disk.
      const listed = yield* withStore((store) => store.enabledThreads());
      assert.deepStrictEqual(listed, [on]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("stamps when it was switched on, and forgets what was shown when switched off", () =>
    Effect.gen(function* () {
      const shownThread = ThreadId.make("thread:shown");
      const result = yield* withStore((store) =>
        Effect.gen(function* () {
          const on = yield* store.setEnabled(shownThread, true);
          yield* store.setShown(shownThread, { topics: { T1: "active" }, items: { q1: "open" } });
          const kept = yield* store.shown(shownThread);
          yield* store.setEnabled(shownThread, false);
          return { on, kept, after: yield* store.shown(shownThread) };
        }),
      );
      assert.isDefined(result.on.enabledAt);
      assert.deepStrictEqual(Option.getOrUndefined(result.kept), {
        topics: { T1: "active" },
        items: { q1: "open" },
      });
      assert.isTrue(Option.isNone(result.after));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("streams the current ledger, then each change to that thread only", () =>
    Effect.gen(function* () {
      const seen = yield* withStore((store) =>
        Effect.gen(function* () {
          const received = yield* Queue.unbounded<LedgerDocument>();
          const fiber = yield* store.stream(threadId).pipe(
            Stream.runForEach((doc) => Queue.offer(received, doc)),
            Effect.forkChild,
          );
          // The current ledger arrives once the stream is subscribed to changes.
          const first = yield* Queue.take(received);
          yield* store.setEnabled(ThreadId.make("thread:other"), true);
          yield* store.setEnabled(threadId, true);
          const second = yield* Queue.take(received);
          yield* Fiber.interrupt(fiber);
          return [first, second];
        }),
      );
      assert.deepStrictEqual(
        seen.map((doc) => [doc.threadId, doc.enabled]),
        [
          [threadId, false],
          [threadId, true],
        ],
      );
    }).pipe(Effect.provide(layer)),
  );
});
