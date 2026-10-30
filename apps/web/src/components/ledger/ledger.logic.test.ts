import { describe, expect, it } from "vite-plus/test";

import {
  cardTopics,
  cardTopicsOverflowLabel,
  closedItemNote,
  closedTopics,
  formatLedgerCost,
  ledgerModelLabel,
  ledgerUpdatedLabel,
  liveTaskProgress,
  liveTopics,
  needsYou,
  needsYouCounts,
  topicCounts,
  topicSections,
  topicSummary,
} from "./ledger.logic";
import { BUSY_LEDGER, OFF_LEDGER, SETTLED_LEDGER } from "./ledgerFixtures";

const topicNamed = (name: string) => BUSY_LEDGER.topics.find((topic) => topic.name === name)!;

describe("ledger topics", () => {
  it("orders live topics by status and folds done and rejected ones", () => {
    expect(liveTopics(BUSY_LEDGER).map((topic) => topic.status)).toEqual([
      "active",
      "review",
      "chosen",
      "hold",
    ]);
    expect(closedTopics(BUSY_LEDGER).map((topic) => topic.status)).toEqual(["done", "rejected"]);
  });

  it("has no live topics once the only topic is done", () => {
    expect(liveTopics(SETTLED_LEDGER)).toEqual([]);
    expect(closedTopics(SETTLED_LEDGER).map((topic) => topic.name)).toEqual([
      "Scripts folder cleanup",
    ]);
  });
});

describe("what needs the user", () => {
  it("lists open questions first, then open to-dos the user owns", () => {
    expect(needsYou(BUSY_LEDGER).map(({ item, topic }) => [item.id, topic.name])).toEqual([
      ["q2", "Fight-scene CPU cost"],
      ["q4", "Skills and XP, milestone 1"],
      ["t2", "Attack slots"],
    ]);
    expect(needsYouCounts(BUSY_LEDGER)).toEqual({ questions: 2, checks: 1 });
  });

  it("ignores answered questions and topics that are done", () => {
    expect(needsYou(SETTLED_LEDGER)).toEqual([]);
    expect(needsYouCounts(OFF_LEDGER)).toEqual({ questions: 0, checks: 0 });
  });
});

describe("topic counts", () => {
  it("counts open, decided and closed items", () => {
    expect(topicCounts(topicNamed("Attack slots"))).toEqual({
      openQuestions: 0,
      openTodos: 2,
      decided: 2,
      closed: 2,
    });
    expect(topicSummary(topicNamed("Skills and XP, milestone 1"))).toBe(
      "1 question · 1 to-do · 1 decided",
    );
    expect(topicSummary(SETTLED_LEDGER.topics[0]!)).toBe("1 closed");
    expect(topicSummary(topicNamed("Second dev client"))).toBe("Nothing recorded yet");
  });

  it("keeps closed items out of the Open view and after the open ones in All", () => {
    const attack = topicNamed("Attack slots");
    const open = topicSections(attack, false);
    expect(open.decided.map((item) => item.id)).toEqual(["d2", "d1"]);
    expect(open.todos.map((item) => item.id)).toEqual(["t1", "t2"]);
    expect(open.closedCount).toBe(2);

    const all = topicSections(attack, true);
    expect(all.decided.map((item) => item.id)).toEqual(["d2", "d1", "d3"]);
    expect(all.todos.map((item) => item.id)).toEqual(["t1", "t2", "t3"]);
  });
});

describe("thread details card topics", () => {
  it("shows three live topics and sums up the rest", () => {
    const topics = cardTopics(BUSY_LEDGER);
    expect(topics.shown.map((topic) => topic.name)).toEqual([
      "Attack slots",
      "Fight-scene CPU cost",
      "Skills and XP, milestone 1",
    ]);
    expect(cardTopicsOverflowLabel(topics)).toBe("+ 1 on hold, 2 done");
  });

  it("names live topics past the limit that are not on hold", () => {
    expect(cardTopicsOverflowLabel(cardTopics(BUSY_LEDGER, 1))).toBe("+ 2 more, 1 on hold, 2 done");
  });

  it("has nothing to sum up when every topic has a row", () => {
    expect(cardTopicsOverflowLabel(cardTopics(BUSY_LEDGER, 10))).toBe("+ 2 done");
    expect(cardTopicsOverflowLabel(cardTopics(OFF_LEDGER))).toBeNull();
  });
});

describe("labels", () => {
  it("says when the ledger last updated", () => {
    expect(ledgerUpdatedLabel(BUSY_LEDGER)).toBe("Turn 41 · cleaned up at turn 40");
    expect(ledgerUpdatedLabel(SETTLED_LEDGER)).toBe("Turn 3");
    expect(ledgerUpdatedLabel({ ...OFF_LEDGER, enabled: true })).toBe("Starts from the next turn");
  });

  it("names model aliases and keeps full model ids", () => {
    expect(ledgerModelLabel("haiku")).toBe("Haiku");
    expect(ledgerModelLabel("claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
  });

  it("formats the thread's cost", () => {
    expect(formatLedgerCost(0)).toBe("$0.00");
    expect(formatLedgerCost(SETTLED_LEDGER.costUsd)).toBe("<$0.01");
    expect(formatLedgerCost(0.314)).toBe("$0.31");
  });

  it("leads a closed item's note with its turn", () => {
    const measured = topicNamed("Attack slots").items.find((item) => item.id === "t3")!;
    expect(closedItemNote(measured)).toBe("Turn 38: 14 ms at 50 zombies");
    expect(closedItemNote(SETTLED_LEDGER.topics[0]!.items[0]!)).toBe(
      "Turn 3: the user said no, don't split check-tenant-guards.ts; leave it as is",
    );
    const { note: _note, ...withoutNote } = measured;
    expect(closedItemNote(withoutNote)).toBe("Turn 38");
  });

  it("counts finished live tasks", () => {
    expect(liveTaskProgress(BUSY_LEDGER.liveTasks)).toEqual({ completed: 1, total: 3 });
  });
});
