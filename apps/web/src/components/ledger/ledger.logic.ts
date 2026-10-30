import type {
  LedgerDocument,
  LedgerItem,
  LedgerLiveTask,
  LedgerTopic,
  LedgerTopicStatus,
} from "@t3tools/contracts";

/** Order of the topics still in play: work under way first, parked work last. */
const LIVE_TOPIC_ORDER = ["active", "review", "chosen", "shaped", "exploring", "hold"] as const;
type LiveTopicStatus = (typeof LIVE_TOPIC_ORDER)[number];

export const TOPIC_STATUS_LABELS: Readonly<Record<LedgerTopicStatus, string>> = {
  exploring: "Exploring",
  shaped: "Shaped",
  chosen: "Chosen",
  active: "Active",
  review: "Review",
  hold: "Hold",
  rejected: "Rejected",
  done: "Done",
};

function isLiveTopic(topic: LedgerTopic): boolean {
  return topic.status !== "done" && topic.status !== "rejected";
}

/** Topics still in play, ordered by status and then as the scribe recorded them. */
export function liveTopics(ledger: LedgerDocument): ReadonlyArray<LedgerTopic> {
  const rank = (topic: LedgerTopic) => LIVE_TOPIC_ORDER.indexOf(topic.status as LiveTopicStatus);
  return ledger.topics.filter(isLiveTopic).toSorted((left, right) => rank(left) - rank(right));
}

/** Done and rejected topics, folded away at the end of the panel. */
export function closedTopics(ledger: LedgerDocument): ReadonlyArray<LedgerTopic> {
  return ledger.topics.filter((topic) => !isLiveTopic(topic));
}

/** Work under way and work waiting on a check open by default; the rest start folded. */
export function topicStartsExpanded(topic: LedgerTopic): boolean {
  return topic.status === "active" || topic.status === "review";
}

function isOpenItem(item: LedgerItem): boolean {
  return item.state === "open";
}

/** Answered questions, finished or dropped to-dos, and decisions that no longer stand. */
export function isClosedItem(item: LedgerItem): boolean {
  return item.kind === "decision" ? item.state !== "recorded" : item.state !== "open";
}

/** A to-do the user owns: something they said they would do or check. */
function isUserCheck(item: LedgerItem): boolean {
  return item.kind === "todo" && item.owner === "user" && isOpenItem(item);
}

function isOpenQuestion(item: LedgerItem): boolean {
  return item.kind === "question" && isOpenItem(item);
}

export interface LedgerNeed {
  readonly item: LedgerItem;
  readonly topic: LedgerTopic;
}

/** What waits on the user across the live topics: open questions first, then their checks. */
export function needsYou(ledger: LedgerDocument): ReadonlyArray<LedgerNeed> {
  const topics = liveTopics(ledger);
  const collect = (match: (item: LedgerItem) => boolean) =>
    topics.flatMap((topic) => topic.items.filter(match).map((item) => ({ item, topic })));
  return [...collect(isOpenQuestion), ...collect(isUserCheck)];
}

export interface LedgerNeedCounts {
  readonly questions: number;
  readonly checks: number;
}

export function needsYouCounts(ledger: LedgerDocument): LedgerNeedCounts {
  const needs = needsYou(ledger);
  const questions = needs.filter((need) => need.item.kind === "question").length;
  return { questions, checks: needs.length - questions };
}

export interface LedgerTopicCounts {
  readonly openQuestions: number;
  readonly openTodos: number;
  readonly decided: number;
  readonly closed: number;
}

export function topicCounts(topic: LedgerTopic): LedgerTopicCounts {
  let openQuestions = 0;
  let openTodos = 0;
  let decided = 0;
  let closed = 0;
  for (const item of topic.items) {
    if (isClosedItem(item)) closed += 1;
    else if (item.kind === "question") openQuestions += 1;
    else if (item.kind === "todo") openTodos += 1;
    else decided += 1;
  }
  return { openQuestions, openTodos, decided, closed };
}

function counted(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** One line under a folded topic: what is open and what stands. */
export function topicSummary(topic: LedgerTopic): string {
  const counts = topicCounts(topic);
  const parts = [
    counts.openQuestions > 0 ? counted(counts.openQuestions, "question") : null,
    counts.openTodos > 0 ? counted(counts.openTodos, "to-do") : null,
    counts.decided > 0 ? `${counts.decided} decided` : null,
  ].filter((part) => part !== null);
  if (parts.length > 0) return parts.join(" · ");
  return counts.closed > 0 ? `${counts.closed} closed` : "Nothing recorded yet";
}

export interface LedgerTopicSections {
  readonly questions: ReadonlyArray<LedgerItem>;
  readonly decided: ReadonlyArray<LedgerItem>;
  readonly todos: ReadonlyArray<LedgerItem>;
  /** Items the Open view folds behind "Show N closed". */
  readonly closedCount: number;
}

/**
 * A topic's items by kind. Closed items are left out unless showClosed is set, and then each
 * closed item stays under its own kind, after the open ones. Decisions pile up over a long
 * thread, so they run newest first.
 */
export function topicSections(topic: LedgerTopic, showClosed: boolean): LedgerTopicSections {
  const pick = (kind: LedgerItem["kind"], newestFirst = false) => {
    const kept = topic.items.filter((item) => item.kind === kind);
    const items = newestFirst ? kept.toReversed() : kept;
    const open = items.filter((item) => !isClosedItem(item));
    return showClosed ? [...open, ...items.filter(isClosedItem)] : open;
  };
  return {
    questions: pick("question"),
    decided: pick("decision", true),
    todos: pick("todo"),
    closedCount: topicCounts(topic).closed,
  };
}

export interface LedgerCardTopics {
  /** Shown as rows in the thread details card. */
  readonly shown: ReadonlyArray<LedgerTopic>;
  /** Live topics past the shown ones that are not on hold. */
  readonly moreCount: number;
  readonly holdCount: number;
  /** Done and rejected, as the panel's Done section counts them. */
  readonly doneCount: number;
}

const LEDGER_CARD_TOPIC_LIMIT = 3;

export function cardTopics(
  ledger: LedgerDocument,
  limit: number = LEDGER_CARD_TOPIC_LIMIT,
): LedgerCardTopics {
  const live = liveTopics(ledger);
  const shown = live.slice(0, limit);
  const hidden = live.slice(limit);
  const holdCount = hidden.filter((topic) => topic.status === "hold").length;
  return {
    shown,
    moreCount: hidden.length - holdCount,
    holdCount,
    doneCount: closedTopics(ledger).length,
  };
}

/** "+ 1 on hold, 3 done", or null when every topic already has a row. */
export function cardTopicsOverflowLabel(topics: LedgerCardTopics): string | null {
  const parts = [
    topics.moreCount > 0 ? `${topics.moreCount} more` : null,
    topics.holdCount > 0 ? `${topics.holdCount} on hold` : null,
    topics.doneCount > 0 ? `${topics.doneCount} done` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? `+ ${parts.join(", ")}` : null;
}

export function liveTaskProgress(tasks: ReadonlyArray<LedgerLiveTask>) {
  return {
    completed: tasks.filter((task) => task.status === "completed").length,
    total: tasks.length,
  };
}

/** "Turn 41 · cleaned up at turn 40". */
export function ledgerUpdatedLabel(ledger: LedgerDocument): string {
  if (ledger.turns === 0) return "Starts from the next turn";
  const updated = `Turn ${ledger.turns}`;
  return ledger.sweptTurn > 0 ? `${updated} · cleaned up at turn ${ledger.sweptTurn}` : updated;
}

/** A model alias as the footer names it: "haiku" reads "Haiku"; full model ids stay as typed. */
export function ledgerModelLabel(model: string): string {
  return /^[a-z]+$/.test(model) ? model.charAt(0).toUpperCase() + model.slice(1) : model;
}

export function formatLedgerCost(costUsd: number): string {
  if (costUsd <= 0) return "$0.00";
  if (costUsd < 0.01) return "<$0.01";
  return `$${costUsd.toFixed(2)}`;
}

/** What the turn's note says once an item closed: "Turn 38: 14 ms at 50 zombies". */
export function closedItemNote(item: LedgerItem): string | null {
  if (item.note === undefined || item.note.trim() === "") {
    return item.closedTurn === undefined ? null : `Turn ${item.closedTurn}`;
  }
  // The scribe often leads its notes with the turn already.
  if (/^turn \d+/i.test(item.note)) return `T${item.note.slice(1)}`;
  if (item.closedTurn === undefined) return item.note;
  return `Turn ${item.closedTurn}: ${item.note}`;
}

/** What an open question's buttons put in the composer. Never sent: the user finishes and sends it. */
export function questionPrompts(item: LedgerItem) {
  const asked = `Ledger question ${item.id}: "${item.text}"`;
  return {
    answer: `${asked}\nMy answer: `,
    recommended:
      item.rec === undefined
        ? undefined
        : `${asked}\nMy answer: go with your recommendation ("${item.rec}")`,
    explain: `${asked}\nExplain it more before I answer: what it decides, the options, and ${
      item.rec === undefined ? "which you'd pick" : "why you recommend that"
    }.`,
  };
}
