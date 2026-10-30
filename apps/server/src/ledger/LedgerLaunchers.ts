import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

import * as ServerConfig from "../config.ts";

/**
 * Which thread launched which: a thread that starts top-level threads with `t3_thread_launch`
 * (a Director) and the workers it started. T3 itself keeps no such link, so the ledger keeps
 * one small file of them, `<stateDir>/ledgers/launchers.json`.
 */
export class LedgerLaunchers extends Context.Service<
  LedgerLaunchers,
  {
    readonly record: (launcher: ThreadId, worker: ThreadId) => Effect.Effect<void>;
    /** Oldest first. */
    readonly workersOf: (launcher: ThreadId) => Effect.Effect<ReadonlyArray<ThreadId>>;
    /** Drops a deleted thread, as a launcher and as a worker. */
    readonly forget: (threadId: ThreadId) => Effect.Effect<void>;
    /** Each launcher whose workers changed. */
    readonly changes: Stream.Stream<ThreadId>;
  }
>()("t3/ledger/LedgerLaunchers") {}

export const LAUNCHERS_FILE = "launchers.json";

type Links = ReadonlyMap<ThreadId, ReadonlyArray<ThreadId>>;

const LinksJson = Schema.fromJsonString(Schema.Record(ThreadId, Schema.Array(ThreadId)));
const decodeLinks = Schema.decodeEffect(LinksJson);
const encodeLinks = Schema.encodeEffect(LinksJson);

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(config.stateDir, "ledgers", LAUNCHERS_FILE);
  const lock = yield* Semaphore.make(1);
  const loaded = yield* Ref.make<Option.Option<Links>>(Option.none());
  const changed = yield* PubSub.unbounded<ThreadId>();

  // A file that cannot be read loses its links, never the server: workers views just go empty.
  const read = Effect.gen(function* () {
    const cached = yield* Ref.get(loaded);
    if (Option.isSome(cached)) return cached.value;
    const links: Links = yield* fs.readFileString(filePath).pipe(
      Effect.flatMap(decodeLinks),
      Effect.map((record) => new Map(Object.entries(record) as Array<[ThreadId, ThreadId[]]>)),
      Effect.catchCause((cause) =>
        fs.exists(filePath).pipe(
          Effect.orElseSucceed(() => true),
          Effect.flatMap((exists) =>
            exists
              ? Effect.logWarning("the ledger's launcher links could not be read", { cause })
              : Effect.void,
          ),
          Effect.as(new Map()),
        ),
      ),
    );
    yield* Ref.set(loaded, Option.some(links));
    return links;
  });

  const write = (links: Links) =>
    Ref.set(loaded, Option.some(links)).pipe(
      Effect.andThen(encodeLinks(Object.fromEntries(links))),
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath, contents })),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.catchCause((cause) =>
        Effect.logWarning("saving the ledger's launcher links failed", { cause }),
      ),
    );

  const record: LedgerLaunchers["Service"]["record"] = (launcher, worker) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (launcher === worker) return;
        const links = yield* read;
        const workers = links.get(launcher) ?? [];
        // A retried launch replays the same thread.
        if (workers.includes(worker)) return;
        yield* write(new Map(links).set(launcher, [...workers, worker]));
        yield* PubSub.publish(changed, launcher);
      }),
    );

  const workersOf: LedgerLaunchers["Service"]["workersOf"] = (launcher) =>
    lock.withPermits(1)(Effect.map(read, (links) => links.get(launcher) ?? []));

  const forget: LedgerLaunchers["Service"]["forget"] = (threadId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const links = yield* read;
        const next = new Map<ThreadId, ReadonlyArray<ThreadId>>();
        const touched: ThreadId[] = [];
        for (const [launcher, workers] of links) {
          if (launcher === threadId) continue;
          const kept = workers.filter((worker) => worker !== threadId);
          if (kept.length !== workers.length) touched.push(launcher);
          if (kept.length > 0) next.set(launcher, kept);
        }
        if (next.size === links.size && touched.length === 0) return;
        yield* write(next);
        for (const launcher of touched) yield* PubSub.publish(changed, launcher);
      }),
    );

  return LedgerLaunchers.of({
    record,
    workersOf,
    forget,
    changes: Stream.fromPubSub(changed),
  });
});

export const layer = Layer.effect(LedgerLaunchers, make);

/**
 * For the launch tool: links a launched thread to the thread that launched it. A no-op where the
 * ledger's services are absent (a launch from outside a thread, or a test without them), and it
 * never fails the launch.
 */
export const recordLaunch = (launcher: ThreadId | undefined, worker: ThreadId) =>
  launcher === undefined
    ? Effect.void
    : Effect.serviceOption(LedgerLaunchers).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (launchers) => launchers.record(launcher, worker),
          }),
        ),
      );
