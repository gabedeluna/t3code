import type {
  LedgerDocument,
  LedgerItem,
  LedgerItemState,
  LedgerTopic,
  LedgerTopicStatus,
} from "@t3tools/contracts";

import { renderForAgent } from "./ledgerDocument.ts";

/** Lines of changes a turn's note shows; the rest are counted. */
const CHANGE_LINES = 8;
/** Lines of the whole ledger the first note after switching it on shows. */
const FULL_LINES = 24;
const TEXT_LIMIT = 140;

/**
 * What the working agent has been shown of its ledger: each topic's status and each item's
 * state as of its last note. The next note shows what moved since.
 */
export interface LedgerShown {
  readonly topics: Readonly<Record<string, LedgerTopicStatus>>;
  readonly items: Readonly<Record<string, LedgerItemState>>;
}

export const shownOf = (doc: LedgerDocument): LedgerShown => ({
  topics: Object.fromEntries(doc.topics.map((topic) => [topic.id, topic.status])),
  items: Object.fromEntries(
    doc.topics.flatMap((topic) => topic.items.map((item) => [item.id, item.state])),
  ),
});

/** `shown` plus what moved from `before` to `after`: changes the agent made itself, so no news to it. */
export function withOwnChanges(
  shown: LedgerShown,
  before: LedgerDocument,
  after: LedgerDocument,
): LedgerShown {
  const was = shownOf(before);
  const now = shownOf(after);
  const merged = <S extends string>(
    seen: Readonly<Record<string, S>>,
    from: Readonly<Record<string, S>>,
    to: Readonly<Record<string, S>>,
  ) => ({
    ...seen,
    ...Object.fromEntries(Object.entries(to).filter(([id, value]) => from[id] !== value)),
  });
  return {
    topics: merged(shown.topics, was.topics, now.topics),
    items: merged(shown.items, was.items, now.items),
  };
}

export const sameShown = (a: LedgerShown, b: LedgerShown) => {
  const same = (x: Readonly<Record<string, string>>, y: Readonly<Record<string, string>>) => {
    const keys = Object.keys(x);
    return keys.length === Object.keys(y).length && keys.every((key) => x[key] === y[key]);
  };
  return same(a.topics, b.topics) && same(a.items, b.items);
};

const short = (value: string) => {
  const s = value.replace(/\s+/g, " ").trim();
  return s.length <= TEXT_LIMIT ? s : `${s.slice(0, TEXT_LIMIT - 1)}…`;
};

const isClosed = (state: LedgerItemState) =>
  state === "answered" || state === "done" || state === "dropped";

const label = (item: LedgerItem) =>
  item.kind === "todo" ? `to-do ${item.id} (${item.owner ?? "claude"})` : `${item.kind} ${item.id}`;

const opened = (item: LedgerItem, topic: LedgerTopic) =>
  item.kind === "decision"
    ? `decided ${item.id} (${topic.id}): ${short(item.text)}`
    : `new ${label(item)} (${topic.id}): ${short(item.text)}${
        item.rec ? ` (Claude recommends: ${short(item.rec)})` : ""
      }`;

const closed = (item: LedgerItem, topic: LedgerTopic) =>
  `${item.state} ${label(item)} (${topic.id}): ${short(item.text)}${
    item.note ? ` -> ${short(item.note)}` : ""
  }`;

/** One line per change since `shown`: topic moves first, then what closed, then what opened. */
export function ledgerChanges(doc: LedgerDocument, shown: LedgerShown): ReadonlyArray<string> {
  const topicLines: string[] = [];
  const closeLines: string[] = [];
  const openLines: string[] = [];
  for (const topic of doc.topics) {
    const before = shown.topics[topic.id];
    if (before === undefined) {
      topicLines.push(`new topic ${topic.id} ${topic.name} [${topic.status}]`);
    } else if (before !== topic.status) {
      topicLines.push(`${topic.id} ${topic.name}: ${before} -> ${topic.status}`);
    }
    for (const item of topic.items) {
      const was = shown.items[item.id];
      if (was === item.state) continue;
      if (isClosed(item.state)) {
        // A decision that was never shown and is already replaced is not news.
        if (!(was === undefined && item.kind === "decision")) closeLines.push(closed(item, topic));
      } else if (was === undefined) {
        openLines.push(opened(item, topic));
      }
    }
  }
  return [...topicLines, ...closeLines, ...openLines];
}

const capped = (lines: ReadonlyArray<string>, limit: number, unit: string) =>
  lines.length <= limit
    ? lines
    : [...lines.slice(0, limit), `+${lines.length - limit} more ${unit}, see t3_ledger_read`];

/**
 * The note for the agent's next turn: what changed in its ledger since its last note, or the
 * whole ledger, cut short, when it has not been shown one since the ledger was switched on.
 * Undefined when the ledger is off or nothing changed.
 */
export function ledgerNote(
  doc: LedgerDocument,
  shown: LedgerShown | undefined,
): string | undefined {
  if (!doc.enabled) return undefined;
  if (shown === undefined) {
    if (doc.topics.length === 0) return undefined;
    return [
      "This thread's ledger, kept by T3 after each turn (not part of the user's message):",
      ...capped(renderForAgent(doc).split("\n"), FULL_LINES, "lines"),
    ].join("\n");
  }
  const changes = ledgerChanges(doc, shown);
  if (changes.length === 0) return undefined;
  return [
    "Ledger changes since your last turn, kept by T3 (not part of the user's message):",
    ...capped(changes, CHANGE_LINES, "changes").map((line) => `- ${line}`),
  ].join("\n");
}
