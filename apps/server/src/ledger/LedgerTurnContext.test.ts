import * as NodeServices from "@effect/platform-node/NodeServices";
import type { LedgerDocument } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { ledgerThreadId } from "./ledger.testkit.ts";
import * as LedgerStore from "./LedgerStore.ts";
import * as LedgerTurnContext from "./LedgerTurnContext.ts";

const layer = LedgerTurnContext.layer.pipe(
  Layer.provideMerge(LedgerStore.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-ledger-turn-context-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const typed = {
  text: "Next step?",
  attachments: [],
  createdBy: "user",
  creationSource: "web",
} as const;

const withTopic = (doc: LedgerDocument, status: "exploring" | "chosen"): LedgerDocument => ({
  ...doc,
  topics: [
    {
      id: "T1",
      name: "Auth",
      status,
      turn: 1,
      items: [{ id: "q1", kind: "question", state: "open", text: "Use JWT?", turn: 1 }],
    },
  ],
});

const services = Effect.all({
  context: LedgerTurnContext.LedgerTurnContext,
  store: LedgerStore.LedgerStore,
});

describe("LedgerTurnContext", () => {
  it.effect("gives nothing while the ledger is off", () =>
    Effect.gen(function* () {
      const { context, store } = yield* services;
      yield* store.update(ledgerThreadId, (doc) => withTopic(doc, "exploring"));
      assert.deepStrictEqual(yield* context.forTurn(ledgerThreadId, typed), []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("shows the whole ledger once, then only what changed, each change once", () =>
    Effect.gen(function* () {
      const { context, store } = yield* services;
      yield* store.setEnabled(ledgerThreadId, true);
      yield* store.update(ledgerThreadId, (doc) => withTopic(doc, "exploring"));

      const first = yield* context.forTurn(ledgerThreadId, typed);
      assert.strictEqual(first.length, 1);
      assert.strictEqual(first[0]!.key, "t3_ledger");
      assert.match(first[0]!.text, /^This thread's ledger/);
      assert.match(first[0]!.text, /question q1: Use JWT\?/);

      assert.deepStrictEqual(yield* context.forTurn(ledgerThreadId, typed), []);

      yield* store.update(ledgerThreadId, (doc) => withTopic(doc, "chosen"));
      const second = yield* context.forTurn(ledgerThreadId, typed);
      assert.strictEqual(
        second[0]!.text,
        "Ledger changes since your last turn, kept by T3 (not part of the user's message):\n- T1 Auth: exploring -> chosen",
      );
      assert.deepStrictEqual(yield* context.forTurn(ledgerThreadId, typed), []);

      // Off and on again: the agent is shown the whole ledger again.
      yield* store.setEnabled(ledgerThreadId, false);
      yield* store.setEnabled(ledgerThreadId, true);
      const again = yield* context.forTurn(ledgerThreadId, typed);
      assert.match(again[0]!.text, /^This thread's ledger/);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps a change for a turn that sends the agent a prompt", () =>
    Effect.gen(function* () {
      const { context, store } = yield* services;
      yield* store.setEnabled(ledgerThreadId, true);
      yield* store.update(ledgerThreadId, (doc) => withTopic(doc, "exploring"));
      const wake = { ...typed, createdBy: "agent", creationSource: "provider" } as const;
      const compact = { ...typed, text: " /compact " };
      assert.deepStrictEqual(yield* context.forTurn(ledgerThreadId, wake), []);
      assert.deepStrictEqual(yield* context.forTurn(ledgerThreadId, compact), []);
      assert.strictEqual((yield* context.forTurn(ledgerThreadId, typed)).length, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("is empty by default, for a run executor built without the ledger", () =>
    Effect.gen(function* () {
      const context = yield* LedgerTurnContext.LedgerTurnContext;
      assert.deepStrictEqual(yield* context.forTurn(ledgerThreadId, typed), []);
    }),
  );
});
