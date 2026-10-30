import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as LedgerLaunchers from "./LedgerLaunchers.ts";

const director = ThreadId.make("thread:director");
const workerA = ThreadId.make("thread:a");
const workerB = ThreadId.make("thread:b");

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-ledger-launchers-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

// Each call builds a new service, as a restarted server would, over the same state directory.
const withLaunchers = <A, E>(
  use: (launchers: LedgerLaunchers.LedgerLaunchers["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(LedgerLaunchers.LedgerLaunchers, use).pipe(Effect.provide(LedgerLaunchers.layer));

describe("LedgerLaunchers", () => {
  it.effect("keeps each launcher's workers in order, once each, across restarts", () =>
    Effect.gen(function* () {
      yield* withLaunchers((launchers) =>
        Effect.gen(function* () {
          yield* launchers.record(director, workerA);
          yield* launchers.record(director, workerB);
          yield* launchers.record(director, workerA);
          yield* launchers.record(director, director);
        }),
      );
      assert.deepStrictEqual(yield* withLaunchers((launchers) => launchers.workersOf(director)), [
        workerA,
        workerB,
      ]);
      assert.deepStrictEqual(yield* withLaunchers((launchers) => launchers.workersOf(workerA)), []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("forgets a deleted thread as a worker and as a launcher", () =>
    Effect.gen(function* () {
      const after = yield* withLaunchers((launchers) =>
        Effect.gen(function* () {
          yield* launchers.record(director, workerA);
          yield* launchers.record(director, workerB);
          yield* launchers.record(workerA, workerB);
          yield* launchers.forget(workerA);
          return {
            director: yield* launchers.workersOf(director),
            workerA: yield* launchers.workersOf(workerA),
          };
        }),
      );
      assert.deepStrictEqual(after, { director: [workerB], workerA: [] });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("announces the launcher whose workers changed", () =>
    withLaunchers((launchers) =>
      Effect.gen(function* () {
        const fiber = yield* launchers.changes.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* launchers.record(director, workerA);
        yield* launchers.record(director, workerA);
        yield* launchers.forget(workerA);
        assert.deepStrictEqual(yield* Fiber.join(fiber), [director, director]);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("starts empty when its file cannot be read", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${config.stateDir}/ledgers`, { recursive: true });
      yield* fs.writeFileString(
        `${config.stateDir}/ledgers/${LedgerLaunchers.LAUNCHERS_FILE}`,
        "{",
      );
      assert.deepStrictEqual(
        yield* withLaunchers((launchers) => launchers.workersOf(director)),
        [],
      );
    }).pipe(Effect.provide(layer)),
  );
});
