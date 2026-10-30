import type { LedgerDocument, LedgerItem, LedgerTopic } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { ledgerChanges, ledgerNote, sameShown, shownOf } from "./ledgerDelta.ts";
import { emptyLedger } from "./ledgerDocument.ts";
import { ledgerThreadId } from "./ledger.testkit.ts";

const item = (fields: Partial<LedgerItem> & Pick<LedgerItem, "id" | "kind" | "state">) =>
  ({ text: `About ${fields.id}`, turn: 1, ...fields }) as LedgerItem;

const topic = (fields: Partial<LedgerTopic> & Pick<LedgerTopic, "id">): LedgerTopic => ({
  name: `Topic ${fields.id}`,
  status: "exploring",
  turn: 1,
  items: [],
  ...fields,
});

const ledger = (topics: ReadonlyArray<LedgerTopic>, enabled = true): LedgerDocument => ({
  ...emptyLedger(ledgerThreadId, "2026-10-29T00:00:00.000Z"),
  enabled,
  turns: 3,
  topics,
});

describe("ledgerChanges", () => {
  it("lists topic moves, then what closed, then what opened", () => {
    const before = ledger([
      topic({
        id: "T1",
        name: "Auth",
        items: [
          item({ id: "q1", kind: "question", state: "open", text: "Use JWT?" }),
          item({
            id: "t1",
            kind: "todo",
            state: "open",
            owner: "claude",
            text: "Add the migration",
          }),
          item({ id: "d1", kind: "decision", state: "recorded", text: "Sessions last a day" }),
        ],
      }),
    ]);
    const after = ledger([
      topic({
        id: "T1",
        name: "Auth",
        status: "chosen",
        items: [
          item({ id: "q1", kind: "question", state: "answered", text: "Use JWT?", note: "Yes" }),
          item({
            id: "t1",
            kind: "todo",
            state: "open",
            owner: "claude",
            text: "Add the migration",
          }),
          item({
            id: "d1",
            kind: "decision",
            state: "dropped",
            text: "Sessions last a day",
            note: "An hour",
          }),
          item({ id: "q2", kind: "question", state: "open", text: "Expire after 1h?", rec: "Yes" }),
          item({ id: "t2", kind: "todo", state: "open", owner: "user", text: "Rotate the key" }),
          item({ id: "d2", kind: "decision", state: "recorded", text: "Sessions last an hour" }),
        ],
      }),
      topic({ id: "T2", name: "Billing" }),
    ]);
    assert.deepStrictEqual(ledgerChanges(after, shownOf(before)), [
      "T1 Auth: exploring -> chosen",
      "new topic T2 Billing [exploring]",
      "answered question q1 (T1): Use JWT? -> Yes",
      "dropped decision d1 (T1): Sessions last a day -> An hour",
      "new question q2 (T1): Expire after 1h? (Claude recommends: Yes)",
      "new to-do t2 (user) (T1): Rotate the key",
      "decided d2 (T1): Sessions last an hour",
    ]);
  });

  it("shows a step that opened and closed between turns, but not a decision already replaced", () => {
    const after = ledger([
      topic({
        id: "T1",
        items: [
          item({ id: "t1", kind: "todo", state: "done", owner: "claude", note: "Landed" }),
          item({ id: "d1", kind: "decision", state: "dropped", note: "Replaced" }),
        ],
      }),
    ]);
    const shown = { topics: { T1: "exploring" as const }, items: {} };
    assert.deepStrictEqual(ledgerChanges(after, shown), [
      "done to-do t1 (claude) (T1): About t1 -> Landed",
    ]);
  });
});

describe("ledgerNote", () => {
  const doc = ledger([
    topic({ id: "T1", name: "Auth", items: [item({ id: "q1", kind: "question", state: "open" })] }),
  ]);

  it("says nothing when the ledger is off, or when nothing changed", () => {
    assert.strictEqual(ledgerNote(ledger(doc.topics, false), undefined), undefined);
    assert.strictEqual(ledgerNote(doc, shownOf(doc)), undefined);
  });

  it("shows the whole ledger once after it is switched on, unless it is empty", () => {
    assert.strictEqual(ledgerNote(ledger([]), undefined), undefined);
    assert.strictEqual(
      ledgerNote(doc, undefined),
      [
        "This thread's ledger, kept by T3 after each turn (not part of the user's message):",
        "Ledger after 3 turns.",
        "T1 Auth [exploring]",
        "  question q1: About q1",
      ].join("\n"),
    );
  });

  it("caps a long list of changes and points at t3_ledger_read", () => {
    const many = ledger([
      topic({
        id: "T1",
        items: Array.from({ length: 11 }, (_, i) =>
          item({ id: `t${i + 1}`, kind: "todo", state: "open", owner: "claude" }),
        ),
      }),
    ]);
    const note = ledgerNote(many, { topics: { T1: "exploring" }, items: {} })!.split("\n");
    assert.strictEqual(note.length, 1 + 8 + 1);
    assert.strictEqual(
      note[0],
      "Ledger changes since your last turn, kept by T3 (not part of the user's message):",
    );
    assert.strictEqual(note[1], "- new to-do t1 (claude) (T1): About t1");
    assert.strictEqual(note.at(-1), "- +3 more changes, see t3_ledger_read");
  });

  it("caps the whole ledger too", () => {
    const big = ledger([
      topic({
        id: "T1",
        items: Array.from({ length: 40 }, (_, i) =>
          item({ id: `q${i + 1}`, kind: "question", state: "open" }),
        ),
      }),
    ]);
    const note = ledgerNote(big, undefined)!.split("\n");
    assert.strictEqual(note.length, 1 + 24 + 1);
    assert.strictEqual(note.at(-1), "+18 more lines, see t3_ledger_read");
  });
});

describe("sameShown", () => {
  it("compares statuses and states, not order", () => {
    assert.isTrue(
      sameShown(
        { topics: { T1: "active", T2: "done" }, items: { q1: "open" } },
        { topics: { T2: "done", T1: "active" }, items: { q1: "open" } },
      ),
    );
    assert.isFalse(
      sameShown(
        { topics: { T1: "active" }, items: { q1: "open" } },
        {
          topics: { T1: "active" },
          items: { q1: "answered" },
        },
      ),
    );
  });
});
