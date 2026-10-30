import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  applyScribeReply,
  checkedItem,
  draftOf,
  emptyLedger,
  readScribeReply,
  renderForAgent,
  renderForScribe,
  seededLedger,
  similarity,
} from "./ledgerDocument.ts";

const fresh = () => draftOf(emptyLedger(ThreadId.make("thread-1"), "2026-10-29T00:00:00.000Z"));
const turn = (n: number, sweep = false) => ({ turn: n, sweep, source: "user" as const });

describe("applyScribeReply", () => {
  it("opens a topic and files items under it by name", () => {
    const draft = fresh();
    applyScribeReply(
      draft,
      {
        new_topics: [{ name: "Stone textures", status: "active" }],
        adds: [
          { topic: "Stone textures", kind: "decision", text: "Use 64 px" },
          { topic: "t1", kind: "todo", text: "Tone chert down", owner: "user" },
        ],
      },
      turn(1),
    );
    assert.strictEqual(draft.topics.length, 1);
    assert.deepStrictEqual(
      draft.topics[0]!.items.map((i) => [i.id, i.state, i.owner]),
      [
        ["d1", "recorded", undefined],
        ["t1", "open", "user"],
      ],
    );
  });

  it("reuses a near-identical topic instead of opening a twin", () => {
    const draft = fresh();
    applyScribeReply(
      draft,
      { new_topics: [{ name: "Tenant isolation landing", status: "active" }] },
      turn(1),
    );
    const change = applyScribeReply(
      draft,
      { new_topics: [{ name: "T1 Tenant isolation landing", status: "active" }] },
      turn(2),
    );
    assert.strictEqual(draft.topics.length, 1);
    assert.match(change.skipped[0]!, /same as T1/);
  });

  it("skips a reworded duplicate item", () => {
    const draft = fresh();
    applyScribeReply(
      draft,
      {
        new_topics: [{ name: "Merge", status: "active" }],
        adds: [{ topic: "T1", kind: "todo", text: "Merge the branch after god rays lands" }],
      },
      turn(1),
    );
    applyScribeReply(
      draft,
      { adds: [{ topic: "T1", kind: "todo", text: "Merge the branch after god-rays lands" }] },
      turn(2),
    );
    assert.strictEqual(draft.topics[0]!.items.length, 1);
  });

  it("closes by kind and ignores items already closed", () => {
    const draft = fresh();
    applyScribeReply(
      draft,
      {
        new_topics: [{ name: "Perf", status: "active" }],
        adds: [
          { topic: "T1", kind: "question", text: "Was OBS running?" },
          { topic: "T1", kind: "todo", text: "Measure the fight scene" },
        ],
      },
      turn(1),
    );
    applyScribeReply(
      draft,
      {
        closes: [
          { item: "q1", state: "done", note: "turn 2: Gabe said no" },
          { item: "t1", state: "answered", note: "turn 2: measured, 14 ms" },
        ],
      },
      turn(2),
    );
    const change = applyScribeReply(
      draft,
      { closes: [{ item: "q1", state: "dropped", note: "x" }] },
      turn(3),
    );
    assert.deepStrictEqual(
      draft.topics[0]!.items.map((i) => [i.id, i.state, i.closedTurn]),
      [
        ["q1", "answered", 2],
        ["t1", "done", 2],
      ],
    );
    assert.deepStrictEqual(change.applied, []);
  });

  it("keeps a decision a sweep marks dropped while saying it stands", () => {
    const draft = fresh();
    applyScribeReply(
      draft,
      {
        new_topics: [{ name: "Stone", status: "active" }],
        adds: [{ topic: "T1", kind: "decision", text: "64 px" }],
      },
      turn(1),
    );
    const change = applyScribeReply(
      draft,
      { checks: [{ item: "d1", verdict: "dropped", note: "Decision stands; nothing changed" }] },
      turn(8, true),
    );
    assert.strictEqual(draft.topics[0]!.items[0]!.state, "recorded");
    assert.match(change.skipped[0]!, /still holds/);
  });

  it("refuses decisions from another session's report and topics named like ids", () => {
    const draft = fresh();
    const change = applyScribeReply(
      draft,
      {
        new_topics: [{ name: "t4", status: "active" }],
        adds: [{ topic: "Perf", kind: "decision", text: "Gabe approved the plan" }],
      },
      { turn: 1, sweep: false, source: "other-session" },
    );
    assert.strictEqual(draft.topics.length, 0);
    assert.strictEqual(change.skipped.length, 2);
  });

  it("shows closed items only while they are recent", () => {
    const draft = fresh();
    applyScribeReply(
      draft,
      {
        new_topics: [{ name: "Perf", status: "active" }],
        adds: [{ topic: "T1", kind: "todo", text: "Measure" }],
      },
      turn(1),
    );
    applyScribeReply(
      draft,
      { closes: [{ item: "t1", state: "done", note: "turn 2: done" }] },
      turn(2),
    );
    assert.match(renderForScribe(draft, 3), /t1 done todo/);
    assert.notMatch(renderForScribe(draft, 20), /t1/);
  });
});

describe("seededLedger", () => {
  it("numbers a carried-over ledger from 1, switches it on, and the scribe adds after it", () => {
    const doc = seededLedger(
      emptyLedger(ThreadId.make("thread-1"), "2026-10-29T00:00:00.000Z"),
      [
        {
          name: "Payments",
          status: "active",
          items: [
            { kind: "decision", state: "recorded", text: "Stripe only" },
            { kind: "question", state: "open", text: "Refunds in v1?", rec: "No" },
          ],
        },
        {
          name: "Old spike",
          status: "done",
          items: [{ kind: "todo", state: "done", text: "Try it" }],
        },
      ],
      "2026-10-30T00:00:00.000Z",
    );
    assert.isTrue(doc.enabled);
    assert.deepStrictEqual(
      doc.topics.map((t) => [t.id, t.turn, t.items.map((i) => [i.id, i.turn])]),
      [
        [
          "T1",
          0,
          [
            ["d1", 0],
            ["q1", 0],
          ],
        ],
        ["T2", 0, [["t1", 0]]],
      ],
    );
    const draft = draftOf(doc);
    applyScribeReply(
      draft,
      { adds: [{ topic: "T1", kind: "question", text: "Which payout schedule?" }] },
      turn(1),
    );
    assert.strictEqual(draft.topics[0]!.items.at(-1)!.id, "q2");
  });
});

describe("checkedItem", () => {
  it("checks off and reopens only the user's own to-dos", () => {
    const doc = {
      ...seededLedger(
        emptyLedger(ThreadId.make("thread-1"), "2026-10-29T00:00:00.000Z"),
        [
          {
            name: "Release",
            status: "review",
            items: [
              { kind: "todo", state: "open", owner: "user", text: "Press Ctrl+R" },
              { kind: "todo", state: "open", owner: "claude", text: "Rebuild" },
              { kind: "question", state: "open", text: "Ship tonight?" },
            ],
          },
        ],
        "2026-10-30T00:00:00.000Z",
      ),
      turns: 14,
    };
    const checked = checkedItem(doc, "t1", true);
    assert.deepInclude(checked.topics[0]!.items[0], {
      state: "done",
      note: "checked off by the user",
      closedTurn: 14,
    });
    assert.strictEqual(checkedItem(checked, "t1", true), checked);
    assert.strictEqual(checkedItem(doc, "t2", true), doc);
    assert.strictEqual(checkedItem(doc, "q1", true), doc);

    const reopened = checkedItem(checked, "t1", false).topics[0]!.items[0]!;
    assert.strictEqual(reopened.state, "open");
    assert.notProperty(reopened, "note");
    assert.notProperty(reopened, "closedTurn");
  });
});

describe("readScribeReply", () => {
  it("keeps well-formed entries and drops the rest", () => {
    const reply = readScribeReply({
      closes: [
        { item: "q1", state: "answered", note: "turn 2: yes" },
        { item: "q2", state: "maybe" },
        "x",
      ],
      adds: [
        { topic: "T1", kind: "todo", text: "Ship it", owner: "user" },
        { topic: "T1", kind: "wish", text: "No such kind" },
        { topic: "T1", kind: "question" },
      ],
      statuses: "not a list",
    });
    assert.deepStrictEqual(reply.closes, [{ item: "q1", state: "answered", note: "turn 2: yes" }]);
    assert.deepStrictEqual(reply.adds, [
      { topic: "T1", kind: "todo", text: "Ship it", owner: "user" },
    ]);
    assert.deepStrictEqual(reply.statuses, []);
    assert.deepStrictEqual(readScribeReply(null).checks, []);
  });
});

describe("renderForAgent", () => {
  it("says so when the ledger is off", () => {
    assert.strictEqual(
      renderForAgent(draftOf(emptyLedger(ThreadId.make("t"), "now"))),
      "Ledger is off for this thread.",
    );
  });

  it("lists what is open and what stands, and counts the rest", () => {
    const draft = fresh();
    draft.enabled = true;
    applyScribeReply(
      draft,
      {
        new_topics: [
          { name: "Stone textures", status: "active" },
          { name: "Old idea", status: "rejected" },
        ],
        adds: [
          { topic: "T1", kind: "question", text: "64 or 128 px?", rec: "64 px" },
          { topic: "T1", kind: "todo", text: "Check the torch in game", owner: "user" },
          { topic: "T1", kind: "decision", text: "Keep the old palette" },
          { topic: "T1", kind: "todo", text: "Resize textures" },
        ],
      },
      turn(1),
    );
    applyScribeReply(
      draft,
      { closes: [{ item: "t2", state: "done", note: "turn 2: resized" }] },
      turn(2),
    );
    draft.turns = 2;
    draft.liveTasks = [{ id: "1", text: "Resize textures", status: "completed" }];
    assert.strictEqual(
      renderForAgent(draft),
      [
        "Ledger after 2 turns.",
        "Task list: [done] Resize textures",
        "T1 Stone textures [active]",
        "  question q1: 64 or 128 px? (Claude recommends: 64 px)",
        "  to-do t1 (user): Check the torch in game",
        "  decision d1: Keep the old palette",
        "  1 closed item",
        "Finished: T2 Old idea [rejected]",
      ].join("\n"),
    );
  });

  it("says how many turns a restart's catch-up left unread", () => {
    const draft = fresh();
    draft.enabled = true;
    draft.missedTurns = 3;
    assert.strictEqual(
      renderForAgent(draft),
      "Ledger after 0 turns.\n3 turns ended while T3 was down and were never read.\nNo topics yet.",
    );
  });
});

describe("similarity", () => {
  it("scores rewordings high and unrelated text low", () => {
    assert.isAbove(similarity("Merge after god rays", "merge after god-rays"), 0.8);
    assert.isBelow(similarity("Merge after god rays", "Tone chert down"), 0.4);
  });
});
