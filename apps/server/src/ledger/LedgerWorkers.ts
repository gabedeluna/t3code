import { type OrchestrationV2DomainEvent, type ThreadId, ThreadWorkers } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as LedgerLaunchers from "./LedgerLaunchers.ts";
import { workerOf } from "./ledgerRollup.ts";
import * as LedgerStore from "./LedgerStore.ts";

/**
 * A launcher's workers, each from its thread shell and its ledger: what the Director's workers
 * view and `t3_ledger_workers` read. Reads only: no model call, and no worker's ledger is ever
 * switched on from here.
 */
export class LedgerWorkers extends Context.Service<
  LedgerWorkers,
  {
    /** Launch order; deleted workers are left out. */
    readonly rollup: (launcher: ThreadId) => Effect.Effect<ThreadWorkers>;
    /** The rollup now, then again whenever a worker's ledger or status changes. */
    readonly stream: (launcher: ThreadId) => Stream.Stream<ThreadWorkers>;
  }
>()("t3/ledger/LedgerWorkers") {}

/** Bursts of events (a turn streaming) become one read. */
const SETTLE = "300 millis";
/** A safety net for a change no event announces. */
const REFRESH = "30 seconds";

// Events that move a thread's sidebar status; turn items and messages stream far too often.
const movesStatus = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("run.") ||
  event.type.startsWith("runtime-request.") ||
  event.type.startsWith("thread.");

const sameWorkers = Schema.toEquivalence(ThreadWorkers);

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const launchers = yield* LedgerLaunchers.LedgerLaunchers;
  const store = yield* LedgerStore.LedgerStore;

  const rollup: LedgerWorkers["Service"]["rollup"] = Effect.fnUntraced(function* (launcher) {
    const ids = yield* launchers.workersOf(launcher);
    const workers = yield* Effect.forEach(
      ids,
      (id) =>
        Effect.gen(function* () {
          const shell = yield* projections
            .getThreadShell(id)
            .pipe(Effect.orElseSucceed(() => null));
          if (shell === null || shell.deletedAt !== null) return [];
          return [workerOf(shell, yield* store.get(id))];
        }),
      { concurrency: 4 },
    );
    return { threadId: launcher, workers: workers.flat() };
  });

  const stream: LedgerWorkers["Service"]["stream"] = (launcher) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const watched = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
        const isWorker = (threadId: ThreadId) =>
          Effect.map(Ref.get(watched), (ids) => ids.has(threadId));
        const triggers = Stream.mergeAll(
          [
            launchers.changes.pipe(
              Stream.filter((changed) => changed === launcher),
              Stream.as(undefined),
            ),
            store.changes.pipe(
              Stream.filterEffect((doc) => isWorker(doc.threadId)),
              Stream.as(undefined),
            ),
            engine.streamDomainEvents.pipe(
              Stream.filter(movesStatus),
              Stream.filterEffect((event) => isWorker(event.threadId)),
              Stream.as(undefined),
              Stream.catchCause(() => Stream.empty),
            ),
            Stream.tick(REFRESH).pipe(Stream.drop(1), Stream.as(undefined)),
          ],
          { concurrency: "unbounded" },
        );
        return Stream.make(undefined).pipe(
          Stream.concat(triggers.pipe(Stream.debounce(SETTLE))),
          Stream.mapEffect(() =>
            rollup(launcher).pipe(
              Effect.tap((current) =>
                Ref.set(watched, new Set(current.workers.map((worker) => worker.threadId))),
              ),
            ),
          ),
          Stream.changesWith(sameWorkers),
        );
      }),
    );

  return LedgerWorkers.of({ rollup, stream });
});

export const layer = Layer.effect(LedgerWorkers, make);
