import {
  LedgerDocument,
  LedgerItemState,
  LedgerTopicStatus,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as KeyedLock from "@t3tools/shared/KeyedLock";

import * as ServerConfig from "../config.ts";
import type { LedgerShown } from "./ledgerDelta.ts";
import { emptyLedger } from "./ledgerDocument.ts";
import { type LedgerTurn, recentTurn } from "./ledgerPrompts.ts";

/**
 * Each thread's ledger, one JSON file per thread under `<stateDir>/ledgers`, plus a sidecar of
 * the last few turns the sweep rereads. The sidecar never reaches clients. Every change is
 * published, so the WebSocket feed and `t3_ledger_read` see the same document the scribe keeps.
 */
export class LedgerStore extends Context.Service<
  LedgerStore,
  {
    /** The thread's ledger, or an empty one that is off when it has none. */
    readonly get: (threadId: ThreadId) => Effect.Effect<LedgerDocument>;
    readonly setEnabled: (threadId: ThreadId, enabled: boolean) => Effect.Effect<LedgerDocument>;
    /** Reads, changes and saves the ledger under the thread's lock. */
    readonly update: (
      threadId: ThreadId,
      change: (doc: LedgerDocument) => LedgerDocument,
    ) => Effect.Effect<LedgerDocument>;
    readonly recentTurns: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<LedgerTurn>>;
    /** Keeps the newest `keep` turns, each cut to what a sweep reads. */
    readonly appendTurn: (
      threadId: ThreadId,
      turn: LedgerTurn,
      keep: number,
    ) => Effect.Effect<void>;
    /** What the working agent was last shown of the ledger; none since it was switched on. */
    readonly shown: (threadId: ThreadId) => Effect.Effect<Option.Option<LedgerShown>>;
    readonly setShown: (threadId: ThreadId, shown: LedgerShown) => Effect.Effect<void>;
    readonly remove: (threadId: ThreadId) => Effect.Effect<void>;
    /** Every thread whose ledger is on. */
    readonly enabledThreads: () => Effect.Effect<ReadonlyArray<ThreadId>>;
    /** The current ledger, then each change. */
    readonly stream: (threadId: ThreadId) => Stream.Stream<LedgerDocument>;
    /** Each change to any thread's ledger. */
    readonly changes: Stream.Stream<LedgerDocument>;
  }
>()("t3/ledger/LedgerStore") {}

const LedgerTurnSchema = Schema.Struct({
  number: Schema.Number,
  incoming: Schema.String,
  reply: Schema.String,
  tools: Schema.Array(Schema.String),
});
const DocumentJson = Schema.fromJsonString(LedgerDocument);
const TurnsJson = Schema.fromJsonString(Schema.Array(LedgerTurnSchema));
const ShownJson = Schema.fromJsonString(
  Schema.Struct({
    topics: Schema.Record(Schema.String, LedgerTopicStatus),
    items: Schema.Record(Schema.String, LedgerItemState),
  }),
);
const decodeDocument = Schema.decodeEffect(DocumentJson);
const encodeDocument = Schema.encodeEffect(DocumentJson);
const decodeTurns = Schema.decodeEffect(TurnsJson);
const encodeTurns = Schema.encodeEffect(TurnsJson);
const decodeShown = Schema.decodeEffect(ShownJson);
const encodeShown = Schema.encodeEffect(ShownJson);

// Thread ids hold characters such as ":" that Windows refuses in file names.
const fileStem = (threadId: ThreadId) => encodeURIComponent(threadId).replace(/\*/g, "%2A");

/** `scribing` describes this process's work in flight, so a restart must not inherit it. */
const stored = ({ scribing: _scribing, ...doc }: LedgerDocument): LedgerDocument => doc;

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(config.stateDir, "ledgers");
  const documentPath = (threadId: ThreadId) => path.join(directory, `${fileStem(threadId)}.json`);
  const turnsPath = (threadId: ThreadId) =>
    path.join(directory, `${fileStem(threadId)}.turns.json`);
  const shownPath = (threadId: ThreadId) =>
    path.join(directory, `${fileStem(threadId)}.shown.json`);

  const cache = yield* Ref.make<ReadonlyMap<ThreadId, LedgerDocument>>(new Map());
  const locks = yield* KeyedLock.make<ThreadId>();
  const changes = yield* PubSub.unbounded<LedgerDocument>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const readFile = (
    filePath: string,
  ): Effect.Effect<Option.Option<string>, PlatformError.PlatformError> =>
    fs.readFileString(filePath).pipe(
      Effect.asSome,
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeedNone,
      ),
    );

  // The copy in memory stays current when a save fails; the next change saves it again.
  const save = <E>(filePath: string, contents: Effect.Effect<string, E>) =>
    contents.pipe(
      Effect.flatMap((text) => writeFileStringAtomically({ filePath, contents: text })),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.catchCause((cause) =>
        Effect.logWarning("saving a thread ledger failed", { filePath, cause }),
      ),
    );

  // A file that cannot be read starts the ledger over, switched off: never a reason to scribe.
  const load = Effect.fnUntraced(function* (threadId: ThreadId) {
    const cached = (yield* Ref.get(cache)).get(threadId);
    if (cached !== undefined) return cached;
    const contents = yield* readFile(documentPath(threadId));
    const doc = Option.isNone(contents)
      ? emptyLedger(threadId, yield* nowIso)
      : yield* decodeDocument(contents.value).pipe(
          Effect.map(stored),
          Effect.catchCause((cause) =>
            Effect.logWarning("a thread ledger could not be read; starting it over", {
              threadId,
              cause,
            }).pipe(Effect.andThen(Effect.map(nowIso, (now) => emptyLedger(threadId, now)))),
          ),
        );
    yield* Ref.update(cache, (current) => new Map(current).set(threadId, doc));
    return doc;
  });

  const get: LedgerStore["Service"]["get"] = (threadId) =>
    load(threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("reading a thread ledger failed", { threadId, cause }).pipe(
          Effect.andThen(Effect.map(nowIso, (now) => emptyLedger(threadId, now))),
        ),
      ),
    );

  // A file that exists but can't be read right now (say, held by a virus scanner) is never
  // overwritten with a fresh ledger: the change is dropped and the next one tries again.
  const update: LedgerStore["Service"]["update"] = (threadId, change) =>
    locks.withLock(
      threadId,
      Effect.gen(function* () {
        const loaded = yield* Effect.result(load(threadId));
        if (Result.isFailure(loaded)) {
          yield* Effect.logWarning("a thread ledger could not be read; leaving its file as it is", {
            threadId,
            cause: loaded.failure,
          });
          return emptyLedger(threadId, yield* nowIso);
        }
        const current = loaded.success;
        const next = change(current);
        if (next === current) return current;
        const changed = { ...next, updatedAt: yield* nowIso };
        yield* Ref.update(cache, (docs) => new Map(docs).set(threadId, changed));
        yield* save(documentPath(threadId), encodeDocument(stored(changed)));
        yield* PubSub.publish(changes, changed);
        return changed;
      }),
    );

  // Switching it off forgets what the agent was shown, so switching it back on shows it all again.
  const setEnabled: LedgerStore["Service"]["setEnabled"] = (threadId, enabled) =>
    Effect.flatMap(nowIso, (now) =>
      update(threadId, (doc) =>
        doc.enabled === enabled ? doc : { ...doc, enabled, ...(enabled ? { enabledAt: now } : {}) },
      ),
    ).pipe(
      Effect.tap(() =>
        enabled
          ? Effect.void
          : locks.withLock(
              threadId,
              fs.remove(shownPath(threadId), { force: true }).pipe(Effect.ignore({ log: true })),
            ),
      ),
    );

  const recentTurns: LedgerStore["Service"]["recentTurns"] = (threadId) =>
    readFile(turnsPath(threadId)).pipe(
      Effect.flatMap((contents) =>
        Option.isNone(contents) ? Effect.succeed([]) : decodeTurns(contents.value),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("reading a thread ledger's recent turns failed", {
          threadId,
          cause,
        }).pipe(Effect.as([])),
      ),
    );

  const appendTurn: LedgerStore["Service"]["appendTurn"] = (threadId, turn, keep) =>
    locks.withLock(
      threadId,
      Effect.gen(function* () {
        const turns = [...(yield* recentTurns(threadId)), recentTurn(turn)].slice(-keep);
        yield* save(turnsPath(threadId), encodeTurns(turns));
      }),
    );

  const shown: LedgerStore["Service"]["shown"] = (threadId) =>
    readFile(shownPath(threadId)).pipe(
      Effect.flatMap((contents) =>
        Option.isNone(contents) ? Effect.succeedNone : Effect.asSome(decodeShown(contents.value)),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("reading what a thread's agent was shown of its ledger failed", {
          threadId,
          cause,
        }).pipe(Effect.as(Option.none())),
      ),
    );

  const setShown: LedgerStore["Service"]["setShown"] = (threadId, value) =>
    locks.withLock(threadId, save(shownPath(threadId), encodeShown(value)));

  const remove: LedgerStore["Service"]["remove"] = (threadId) =>
    locks.withLock(
      threadId,
      Effect.gen(function* () {
        yield* Ref.update(cache, (docs) => {
          const next = new Map(docs);
          next.delete(threadId);
          return next;
        });
        for (const filePath of [documentPath(threadId), turnsPath(threadId), shownPath(threadId)]) {
          yield* fs.remove(filePath, { force: true }).pipe(Effect.ignore({ log: true }));
        }
      }),
    );

  // Other files share the directory (each ledger's sidecars, the launcher links): only a file
  // that reads as a ledger counts, and one that doesn't is skipped without a warning.
  const enabledThreads: LedgerStore["Service"]["enabledThreads"] = Effect.fnUntraced(
    function* () {
      const names = yield* fs.readDirectory(directory).pipe(
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed([]),
        ),
      );
      const cached = yield* Ref.get(cache);
      const enabled: ThreadId[] = [];
      for (const name of names) {
        if (!name.endsWith(".json") || /\.(turns|shown)\.json$/.test(name)) continue;
        const doc = yield* readFile(path.join(directory, name)).pipe(
          Effect.flatMap((contents) =>
            Option.isNone(contents)
              ? Effect.succeedNone
              : Effect.asSome(decodeDocument(contents.value)),
          ),
          Effect.orElseSucceed(() => Option.none<LedgerDocument>()),
        );
        if (Option.isNone(doc)) continue;
        const current = cached.get(doc.value.threadId) ?? doc.value;
        if (current.enabled) enabled.push(current.threadId);
      }
      return enabled;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("listing thread ledgers failed", { cause }).pipe(Effect.as([])),
    ),
  );

  // One-slot sliding mailboxes bound a slow WebSocket to the newest ledger.
  const stream: LedgerStore["Service"]["stream"] = (threadId) =>
    Stream.callback<LedgerDocument>(
      (mailbox) =>
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          Queue.offerUnsafe(mailbox, yield* get(threadId));
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.runForEach((doc) =>
              Effect.sync(() => {
                if (doc.threadId === threadId) Queue.offerUnsafe(mailbox, doc);
              }),
            ),
            Effect.forkScoped,
          );
        }),
      { bufferSize: 1, strategy: "sliding" },
    );

  return LedgerStore.of({
    get,
    setEnabled,
    update,
    recentTurns,
    appendTurn,
    shown,
    setShown,
    remove,
    enabledThreads,
    stream,
    changes: Stream.fromPubSub(changes),
  });
});

export const layer = Layer.effect(LedgerStore, make);
