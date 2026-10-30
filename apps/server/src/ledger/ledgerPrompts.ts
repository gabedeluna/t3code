import type { LedgerDocument, LedgerItem, LedgerLiveTask, LedgerTopic } from "@t3tools/contracts";

import {
  LEDGER_TOPIC_STATUSES,
  itemsToCheck,
  liveTopics,
  renderForScribe,
} from "./ledgerDocument.ts";

/** One finished turn as the scribe reads it: never the whole conversation. */
export interface LedgerTurn {
  readonly number: number;
  /** Who sent it, e.g. the user or "[Message from Director]". */
  readonly incoming: string;
  readonly reply: string;
  /** One short line per tool call, including questions asked and the answers received. */
  readonly tools: ReadonlyArray<string>;
}

const TEXT_LIMIT = 6000;
const RECENT_TEXT_LIMIT = 1500;
const TOOL_LINES = 40;
const RECENT_TOOL_LINES = 10;

export const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit / 2)} [...] ${text.slice(-limit / 2)}`;

/** A turn cut to what a sweep reads of it, so the stored recent turns stay small. Clipping twice changes nothing. */
export const recentTurn = (turn: LedgerTurn): LedgerTurn => ({
  number: turn.number,
  incoming: clip(turn.incoming, RECENT_TEXT_LIMIT),
  reply: clip(turn.reply, RECENT_TEXT_LIMIT),
  tools: turn.tools.slice(0, RECENT_TOOL_LINES),
});

/** The per-turn instructions, ported from the replay lab's scribe3.md (hybrid v3h). */
export const scribeSystemPrompt = (
  user: string,
) => `You keep the session ledger for a coding session between ${user} (the user) and Claude. You never talk to anyone. After each turn you read what happened and return the changes to the ledger.

The ledger shows ${user}, at a glance: which topics came up, where each one stands, which questions are still open, what they decided, and each topic's to-dos. It must be current: nothing left open that was settled, no duplicates, no trivia.

## Input
- LEDGER: each topic (id, name, status) with its open questions, open to-dos, decisions, and items closed recently.
- TURN: the incoming message (from ${user}, or from another session such as the Director), Claude's reply, and Claude's tool calls (edits, commands, questions asked, answers received).

## Item kinds
- question: a choice or question Claude put to ${user} that needs their answer. Not questions Claude answered itself, not choices Claude made on its own, not housekeeping.
- decision: something ${user} chose, approved or ruled, or a ruling of ${user}'s that the Director passes on. Claude's recommendation, plan, experiment or test setting is not a decision.
- todo: a real step someone committed to: work ${user} asked for, a step Claude said it will take, or something ${user} will do or check (owner "user"). When Claude lays out a multi-step plan, add each major step. One to-do per step, never per tool call.

## Topic statuses
exploring (being discussed), shaped (options clear, none chosen), chosen (direction decided, work not started), active (being worked on), review (built; what remains is ${user}'s check or sign-off), hold (paused), rejected (dropped), done (finished, nothing left). Several topics can be active at once.

## What to return, in this order
1. closes: first check every open question and open to-do in the LEDGER against this turn, one by one.
   - A question is "answered" when ${user} answered it, picked an option, approved, or went ahead in a way that settles it. It is also "answered" when it stopped mattering: they signed off without it, the work went another way. Say what settled it in the note.
   - A to-do is "done" when this turn shows that exact step happened. The note names what shows it (a commit, a result, ${user}'s words about that step, not another step's).
   - A to-do is "dropped" only when it was abandoned or replaced by another approach. Never drop a step that was done.
   - A decision is "dropped" when ${user} later replaced or reversed it; the note says what replaced it.
   - Start every note with the turn that settles it, e.g. "turn 29: ${user} said no". If you can't point to what settled it, leave it open.
   - A short reply settles a question too: "no", "okay sounds good", "go with your recommendation". So does putting it off: "skip it for now", "not now", "later" (answered, the note says it was put off).
   - What Claude did settles items too: a question Claude asked is answered once Claude went ahead with it (say so: "turn 12: Claude started it"), and when Claude reviews the ledger and reports items as settled, close those items with the reason it gives.
   - Claude is shown this ledger and may repeat it ("the question stays open"); a repeat is not news and never a reason to keep an item open.
   - Leave an item out when nothing in this turn settles it.
2. statuses: the status of EVERY topic that is not done or rejected, as it stands after this turn. Move it when the work moved: ${user} chose a direction (chosen), work started (active), built and waiting on ${user} (review), signed off with a merge or deploy left (active, with that step as an open to-do), nothing left (done).
3. new_topics: only when a separate subject becomes real work. Never a topic whose name matches one already in the LEDGER.
4. adds: new questions, decisions and to-dos. "topic" is a topic id, or the exact name of a topic opened in new_topics. Skip anything the LEDGER already has in other words.
5. revisions: reword an item that became inaccurate, or move a misfiled item ("topic" set to the right topic id).

Keep every text short and plain, one line, in words ${user} would recognize. Empty arrays are fine; most turns change little.

## Examples of mistakes to avoid
- Open question "Build the coverage readout, or leave it out?" ${user} says "looks good, merge it" without mentioning it. Close it: answered, note "moot: ${user} signed off without it".
- Topic "Stone textures [active]". ${user} signs off and the branch is merged. Status done, and close its open to-dos that happened.
- Topic "Night moonlight [active]". ${user} says "looks good, merge it after god rays". Status stays active, with the open to-do "Merge after god rays lands".
- Open to-do "Register the worktree so setup can run". A later tool call shows setup ran after registering. Close it: done. Don't wait for Claude to announce it.
- Open to-do "Release the stuck lease with a script". Claude switched to a fresh lane instead. Close it: dropped, note "replaced by the fresh lane".
- Claude writes "I kept Python rather than switching to PowerShell." That is Claude's own choice: not a question, not a decision.
- The Director's message lists the plan's next ledger step. That is not ${user} approving anything; add no decision.
- Claude says "Built it; check the torch in game and tell me". Add to-do "Check the torch flame in game", owner user, and set the topic to review.`;

const sweepInstructions = (user: string) =>
  `SWEEP. No new turn this time. Below are the recent turns, then every open item and every topic. Return one entry in "checks" for EVERY item listed, in order: "keep" if a question or to-do is really still open, or a decision still stands; otherwise answered, done or dropped, with a note that starts with the turn that settles it ("turn 29: ${user} said no"). Mark a duplicate "dropped" with the note "duplicate of <id>". Drop a decision only when ${user} replaced or reversed it. Then give the status of every topic listed under TOPICS TO CHECK: a topic whose work was merged, shipped or signed off with nothing left is done; one ${user} paused or deferred is hold. Put any rewording or moving in "revisions".`;

const turnText = (turn: LedgerTurn) => {
  const tools = turn.tools.slice(0, TOOL_LINES);
  const more =
    turn.tools.length > TOOL_LINES ? `\n- (+${turn.tools.length - TOOL_LINES} more)` : "";
  return [
    `TURN ${turn.number}`,
    `Incoming message:\n${clip(turn.incoming, TEXT_LIMIT)}`,
    `Claude's reply:\n${clip(turn.reply, TEXT_LIMIT) || "(no text)"}`,
    `Claude's tool calls:\n${tools.map((t) => `- ${t}`).join("\n") || "(none)"}${more}`,
  ].join("\n\n");
};

export const turnPrompt = (doc: LedgerDocument, turn: LedgerTurn) =>
  `LEDGER\n${renderForScribe(doc, turn.number)}\n\n${turnText(turn)}`;

const recentText = (turns: ReadonlyArray<LedgerTurn>) =>
  turns
    .map(
      (t) =>
        `--- Turn ${t.number}\nIncoming: ${clip(t.incoming, RECENT_TEXT_LIMIT)}\nClaude: ${clip(t.reply, RECENT_TEXT_LIMIT)}\n` +
        `Tools: ${t.tools.slice(0, RECENT_TOOL_LINES).join("; ") || "none"}`,
    )
    .join("\n");

export const sweepPrompt = (
  doc: LedgerDocument,
  recent: ReadonlyArray<LedgerTurn>,
  user: string,
) => {
  const items = itemsToCheck(doc)
    .map(({ topic, item }) => `${item.id} (${topic.id}) ${item.state} ${item.kind}: ${item.text}`)
    .join("\n");
  const topics = liveTopics(doc)
    .map(
      (t) =>
        `${t.id} ${t.name} [${t.status}]: ${t.items.filter((i) => i.state === "open").length} open items`,
    )
    .join("\n");
  return [
    sweepInstructions(user),
    `RECENT TURNS\n${recentText(recent)}`,
    `LEDGER\n${renderForScribe(doc, doc.turns)}`,
    `ITEMS TO CHECK\n${items || "(none)"}`,
    `TOPICS TO CHECK\n${topics || "(none)"}`,
  ].join("\n\n");
};

const text = { type: "string" } as const;
const array = (properties: Record<string, unknown>, required: ReadonlyArray<string>) => ({
  type: "array",
  items: { type: "object", properties, required, additionalProperties: false },
});
const statusList = array({ topic: text, status: { enum: LEDGER_TOPIC_STATUSES } }, [
  "topic",
  "status",
]);
const revisions = array({ item: text, text, topic: text }, ["item"]);

export const TURN_REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["closes", "statuses", "new_topics", "adds", "revisions"],
  properties: {
    closes: array({ item: text, state: { enum: ["answered", "done", "dropped"] }, note: text }, [
      "item",
      "state",
      "note",
    ]),
    statuses: statusList,
    new_topics: array({ name: text, status: { enum: LEDGER_TOPIC_STATUSES } }, ["name", "status"]),
    adds: array(
      {
        topic: text,
        kind: { enum: ["question", "decision", "todo"] },
        text,
        owner: { enum: ["claude", "user"] },
        rec: text,
      },
      ["topic", "kind", "text"],
    ),
    revisions,
  },
} as const;

/** For filing a task list the working agent just started, mid-turn, before the scribe runs. */
export const TASK_TOPIC_SYSTEM =
  "You file a coding agent's new task list under the topic of a thread's ledger that the work belongs to. Reply with that topic's id, or an empty string when none fits.";

export const taskTopicPrompt = (
  topics: ReadonlyArray<LedgerTopic>,
  message: string | undefined,
  tasks: ReadonlyArray<LedgerLiveTask>,
) =>
  [
    `TOPICS\n${topics.map((t) => `${t.id} ${t.name} [${t.status}]`).join("\n")}`,
    `THE MESSAGE THE AGENT IS WORKING ON\n${clip(message ?? "", RECENT_TEXT_LIMIT) || "(none)"}`,
    `TASK LIST\n${tasks.map((t) => `- ${t.text}`).join("\n")}`,
  ].join("\n\n");

export const TASK_TOPIC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["topic"],
  properties: { topic: text },
} as const;

/** For a Director's copies of a worker's questions, once the worker's own ledger settles them. */
export const RELAY_SYSTEM =
  "A worker thread just settled some of its questions. Return the Director's open questions that this settles: the same question in other words, or one the answer makes moot. Usually none do. Each note starts with the worker's name and says how it was settled.";

export const relayPrompt = (
  worker: string,
  settled: ReadonlyArray<LedgerItem>,
  open: ReadonlyArray<LedgerItem>,
) =>
  [
    `SETTLED IN ${worker}\n${settled.map((q) => `- ${q.text} -> ${q.note ?? "answered"}`).join("\n")}`,
    `THE DIRECTOR'S OPEN QUESTIONS\n${open.map((q) => `${q.id}: ${q.text}`).join("\n")}`,
  ].join("\n\n");

export const RELAY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["closes"],
  properties: {
    closes: array({ item: text, state: { enum: ["answered"] }, note: text }, [
      "item",
      "state",
      "note",
    ]),
  },
} as const;

export const SWEEP_REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["checks", "statuses", "revisions"],
  properties: {
    checks: array(
      { item: text, verdict: { enum: ["keep", "answered", "done", "dropped"] }, note: text },
      ["item", "verdict", "note"],
    ),
    statuses: statusList,
    revisions,
  },
} as const;
