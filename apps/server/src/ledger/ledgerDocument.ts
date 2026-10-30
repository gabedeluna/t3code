import type {
  LedgerDocument,
  LedgerItem,
  LedgerItemKind,
  LedgerSeedTopic,
  LedgerTopic,
  LedgerTopicStatus,
  ThreadId,
} from "@t3tools/contracts";

export const LEDGER_TOPIC_STATUSES: ReadonlyArray<LedgerTopicStatus> = [
  "exploring",
  "shaped",
  "chosen",
  "active",
  "review",
  "hold",
  "rejected",
  "done",
];
const CLOSED_TOPIC = new Set<LedgerTopicStatus>(["done", "rejected"]);
const PREFIX: Record<LedgerItemKind, string> = { question: "q", decision: "d", todo: "t" };
/** Closed items stay in the scribe's view this many turns, so it sees what it just settled. */
const RECENT_TURNS = 6;
/** Two texts at least this alike are the same item reworded. */
const SIMILAR = 0.8;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type DraftItem = Mutable<LedgerItem>;
type DraftTopic = Omit<Mutable<LedgerTopic>, "items"> & { items: DraftItem[] };
export type LedgerDraft = Omit<Mutable<LedgerDocument>, "topics" | "next"> & {
  topics: DraftTopic[];
  next: Record<string, number>;
};

export const emptyLedger = (threadId: ThreadId, now: string): LedgerDocument => ({
  threadId,
  enabled: false,
  topics: [],
  next: { T: 1, q: 1, d: 1, t: 1 },
  turns: 0,
  sweptTurn: 0,
  liveTasks: [],
  costUsd: 0,
  updatedAt: now,
});

/** A ledger carried over from elsewhere, numbered from 1 and dated turn 0, switched on. */
export function seededLedger(
  doc: LedgerDocument,
  topics: ReadonlyArray<LedgerSeedTopic>,
  now: string,
): LedgerDocument {
  const next: Record<string, number> = { T: 1, q: 1, d: 1, t: 1 };
  const take = (prefix: string) => {
    const n = next[prefix] ?? 1;
    next[prefix] = n + 1;
    return `${prefix}${n}`;
  };
  return {
    ...doc,
    enabled: true,
    enabledAt: now,
    topics: topics.map((topic) => ({
      id: take("T"),
      name: topic.name,
      status: topic.status,
      turn: 0,
      items: topic.items.map((item) => ({ ...item, id: take(PREFIX[item.kind]), turn: 0 })),
    })),
    next,
  };
}

export const draftOf = (doc: LedgerDocument): LedgerDraft => structuredClone(doc) as LedgerDraft;

export interface ScribeClose {
  readonly item: string;
  readonly state: "answered" | "done" | "dropped";
  readonly note: string;
}
export interface ScribeAdd {
  readonly topic: string;
  readonly kind: LedgerItemKind;
  readonly text: string;
  readonly owner?: "claude" | "user";
  readonly rec?: string;
}
export interface ScribeRevision {
  readonly item: string;
  readonly text?: string;
  readonly topic?: string;
}
export interface ScribeStatus {
  readonly topic: string;
  readonly status: LedgerTopicStatus;
}
export interface ScribeTurnReply {
  readonly closes: ReadonlyArray<ScribeClose>;
  readonly statuses: ReadonlyArray<ScribeStatus>;
  readonly new_topics: ReadonlyArray<{ readonly name: string; readonly status: LedgerTopicStatus }>;
  readonly adds: ReadonlyArray<ScribeAdd>;
  readonly revisions: ReadonlyArray<ScribeRevision>;
}
export interface ScribeSweepReply {
  readonly checks: ReadonlyArray<{
    readonly item: string;
    readonly verdict: "keep" | "answered" | "done" | "dropped";
    readonly note: string;
  }>;
  readonly statuses: ReadonlyArray<ScribeStatus>;
  readonly revisions: ReadonlyArray<ScribeRevision>;
}

export interface LedgerChange {
  readonly applied: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
}

const ITEM_KINDS = new Set<string>(["question", "decision", "todo"]);
const CLOSE_STATES = new Set<string>(["answered", "done", "dropped"]);
const VERDICTS = new Set<string>(["keep", "answered", "done", "dropped"]);

const entries = (value: unknown): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(value)
    ? value.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry),
      )
    : [];
const text = (value: unknown) => (typeof value === "string" ? value : undefined);

/**
 * Keeps the well-formed parts of a scribe reply. The JSON schema enforces the shape when the CLI
 * honours it, but the fallback parses free text, and one bad entry must not throw away the rest.
 */
export function readScribeReply(value: unknown): Partial<ScribeTurnReply & ScribeSweepReply> {
  const reply =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    closes: entries(reply.closes).flatMap((c) => {
      const item = text(c.item);
      const state = text(c.state);
      return item && state && CLOSE_STATES.has(state)
        ? [{ item, state: state as ScribeClose["state"], note: text(c.note) ?? "" }]
        : [];
    }),
    statuses: entries(reply.statuses).flatMap((s) => {
      const topic = text(s.topic);
      const status = text(s.status);
      return topic && status ? [{ topic, status: status as LedgerTopicStatus }] : [];
    }),
    new_topics: entries(reply.new_topics).flatMap((t) => {
      const name = text(t.name);
      return name ? [{ name, status: (text(t.status) ?? "exploring") as LedgerTopicStatus }] : [];
    }),
    adds: entries(reply.adds).flatMap((a) => {
      const topic = text(a.topic);
      const kind = text(a.kind);
      const body = text(a.text);
      if (!topic || !kind || !ITEM_KINDS.has(kind) || !body) return [];
      const owner = text(a.owner);
      const rec = text(a.rec);
      return [
        {
          topic,
          kind: kind as LedgerItemKind,
          text: body,
          ...(owner === "user" || owner === "claude" ? { owner } : {}),
          ...(rec ? { rec } : {}),
        },
      ];
    }),
    revisions: entries(reply.revisions).flatMap((r) => {
      const item = text(r.item);
      if (!item) return [];
      const body = text(r.text);
      const topic = text(r.topic);
      return [{ item, ...(body ? { text: body } : {}), ...(topic ? { topic } : {}) }];
    }),
    checks: entries(reply.checks).flatMap((c) => {
      const item = text(c.item);
      const verdict = text(c.verdict);
      return item && verdict && VERDICTS.has(verdict)
        ? [
            {
              item,
              verdict: verdict as ScribeSweepReply["checks"][number]["verdict"],
              note: text(c.note) ?? "",
            },
          ]
        : [];
    }),
  };
}

const findTopic = (draft: LedgerDraft, ref: string | undefined) => {
  const key = (ref ?? "").trim().toLowerCase();
  return draft.topics.find((t) => t.id.toLowerCase() === key || t.name.toLowerCase() === key);
};

const findItem = (draft: LedgerDraft, ref: string | undefined) => {
  const key = (ref ?? "").trim().toLowerCase();
  for (const topic of draft.topics) {
    const item = topic.items.find((i) => i.id.toLowerCase() === key);
    if (item) return { topic, item };
  }
  return undefined;
};

/** A topic name with a leading id the model sometimes copies in ("T2 Night moonlight"). */
const bare = (name: string | undefined) => (name ?? "").trim().replace(/^T\d+\s*[:-]?\s*/i, "");
const looksLikeId = (name: string) => /^[tqd]\d+$/i.test(name);

const bigrams = (text: string) => {
  const s = text.toLowerCase().replace(/\s+/g, " ").trim();
  const grams = new Map<string, number>();
  for (let i = 0; i < s.length - 1; i++) {
    const g = s.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  return grams;
};

/** Dice coefficient over character pairs: 1 for the same text, near 0 for unrelated text. */
export const similarity = (a: string, b: string) => {
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return 1;
  const ga = bigrams(a);
  const gb = bigrams(b);
  let shared = 0;
  let total = 0;
  for (const [g, n] of ga) {
    shared += Math.min(n, gb.get(g) ?? 0);
    total += n;
  }
  for (const n of gb.values()) total += n;
  return total === 0 ? 0 : (2 * shared) / total;
};

/** By id, by exact name, then by a near-identical name, so a reworded name can't open a twin topic. */
const matchTopic = (draft: LedgerDraft, ref: string | undefined) => {
  const exact = findTopic(draft, ref) ?? findTopic(draft, bare(ref));
  if (exact) return exact;
  const key = bare(ref).toLowerCase();
  if (!key) return undefined;
  return draft.topics.find((t) => {
    const name = t.name.toLowerCase();
    return similarity(name, key) >= SIMILAR || name.includes(key) || key.includes(name);
  });
};

const newId = (draft: LedgerDraft, prefix: string) => {
  const n = draft.next[prefix] ?? 1;
  draft.next[prefix] = n + 1;
  return `${prefix}${n}`;
};

const openTopic = (draft: LedgerDraft, name: string, status: LedgerTopicStatus, turn: number) => {
  const topic: DraftTopic = { id: newId(draft, "T"), name, status, turn, items: [] };
  draft.topics.push(topic);
  return topic;
};

const isClosed = (item: LedgerItem) =>
  item.state === "answered" || item.state === "done" || item.state === "dropped";

/** A sweep note like "Decision stands" under a "dropped" verdict means the model meant keep. */
const STILL_HOLDS = /\b(stands|still (holds|stands|valid|true|open|pending))\b/i;

/** Who sent a turn's incoming message, as far as decisions go: only the user or the Director rule. */
export type IncomingSource = "user" | "director" | "other-session";

export interface ApplyOptions {
  readonly turn: number;
  readonly sweep: boolean;
  readonly source: IncomingSource;
}

/**
 * Applies a scribe reply with the guardrails: closes only open items, maps a close to the state its
 * kind allows, drops twin topics and near-duplicate items, refuses decisions from other sessions'
 * reports and ids used as topic names. Statuses go last so a topic opened in this reply can take one.
 */
export function applyScribeReply(
  draft: LedgerDraft,
  reply: Partial<ScribeTurnReply & ScribeSweepReply>,
  options: ApplyOptions,
): LedgerChange {
  const applied: string[] = [];
  const skipped: string[] = [];
  const { turn } = options;

  const closes: ReadonlyArray<ScribeClose> = options.sweep
    ? (reply.checks ?? [])
        .filter((c) => c.verdict !== "keep" && (c.verdict as string) !== "open")
        .map((c) => ({ item: c.item, state: c.verdict as ScribeClose["state"], note: c.note }))
    : (reply.closes ?? []);
  for (const close of closes) {
    const found = findItem(draft, close.item);
    if (!found) {
      skipped.push(`close ${close.item}: unknown item`);
      continue;
    }
    const { item } = found;
    if (isClosed(item)) continue;
    if (STILL_HOLDS.test(close.note ?? "")) {
      skipped.push(`close ${item.id}: note says it still holds`);
      continue;
    }
    // A question can only be answered, a to-do only done; a decision only replaced.
    item.state =
      close.state === "dropped"
        ? "dropped"
        : item.kind === "question"
          ? "answered"
          : item.kind === "todo"
            ? "done"
            : "dropped";
    item.note = close.note ?? "";
    item.closedTurn = turn;
    applied.push(`${item.state} ${item.id}`);
  }

  const aliases = new Map<string, string>();
  for (const nt of options.sweep ? [] : (reply.new_topics ?? [])) {
    const name = bare(nt.name);
    const twin = matchTopic(draft, nt.name);
    if (twin) {
      aliases.set(nt.name, twin.id);
      skipped.push(`topic "${nt.name}": same as ${twin.id}`);
      continue;
    }
    if (!name || looksLikeId(name)) {
      skipped.push(`topic "${nt.name}": name is an id`);
      continue;
    }
    const status = LEDGER_TOPIC_STATUSES.includes(nt.status) ? nt.status : "exploring";
    aliases.set(nt.name, openTopic(draft, name, status, turn).id);
    applied.push(`topic ${name}`);
  }

  for (const add of options.sweep ? [] : (reply.adds ?? [])) {
    if (add.kind === "decision" && options.source === "other-session") {
      skipped.push(`decision "${add.text}": from another session's report`);
      continue;
    }
    let topic =
      findTopic(draft, aliases.get(add.topic) ?? add.topic) ?? matchTopic(draft, add.topic);
    if (!topic) {
      const name = bare(add.topic);
      if (!name || looksLikeId(name)) {
        skipped.push(`${add.kind} "${add.text}": unknown topic ${add.topic}`);
        continue;
      }
      topic = openTopic(draft, name, "exploring", turn);
    }
    const twin = topic.items.find(
      (i) => i.kind === add.kind && similarity(i.text, add.text) >= SIMILAR,
    );
    if (twin) {
      skipped.push(`${add.kind} "${add.text}": duplicate of ${twin.id}`);
      continue;
    }
    const item: DraftItem = {
      id: newId(draft, PREFIX[add.kind]),
      kind: add.kind,
      state: add.kind === "decision" ? "recorded" : "open",
      text: add.text,
      turn,
    };
    if (add.kind === "todo") item.owner = add.owner === "user" ? "user" : "claude";
    if (add.kind === "question" && add.rec) item.rec = add.rec;
    topic.items.push(item);
    applied.push(`${add.kind} ${item.id}`);
  }

  for (const revision of reply.revisions ?? []) {
    const found = findItem(draft, revision.item);
    if (!found) {
      skipped.push(`revise ${revision.item}: unknown item`);
      continue;
    }
    if (revision.text) {
      found.item.text = revision.text;
      applied.push(`revise ${found.item.id}`);
    }
    if (revision.topic) {
      const target = matchTopic(draft, revision.topic);
      if (!target) {
        skipped.push(`move ${found.item.id}: unknown topic ${revision.topic}`);
      } else if (target !== found.topic) {
        found.topic.items = found.topic.items.filter((i) => i !== found.item);
        target.items.push(found.item);
        applied.push(`move ${found.item.id} to ${target.id}`);
      }
    }
  }

  for (const s of reply.statuses ?? []) {
    const topic = matchTopic(draft, aliases.get(s.topic) ?? s.topic);
    if (topic && topic.status !== s.status && LEDGER_TOPIC_STATUSES.includes(s.status)) {
      topic.status = s.status;
      applied.push(`status ${topic.id} ${s.status}`);
    }
  }
  return { applied, skipped };
}

/** Every topic; under each live one its open items, standing decisions, and recently closed items. */
export function renderForScribe(doc: LedgerDocument, turn: number): string {
  if (doc.topics.length === 0) return "(empty)";
  const lines: string[] = [];
  for (const topic of doc.topics) {
    lines.push(`${topic.id} ${topic.name} [${topic.status}]`);
    if (CLOSED_TOPIC.has(topic.status)) continue;
    for (const item of topic.items) {
      if (item.state === "open") {
        const who = item.kind === "todo" ? ` (${item.owner ?? "claude"})` : "";
        const rec = item.rec ? ` (rec: ${item.rec})` : "";
        lines.push(`  ${item.id} open ${item.kind}${who}: ${item.text}${rec}`);
      } else if (item.kind === "decision" && item.state === "recorded") {
        lines.push(`  ${item.id} decision: ${item.text}`);
      } else if (turn - (item.closedTurn ?? -99) <= RECENT_TURNS) {
        lines.push(`  ${item.id} ${item.state} ${item.kind}: ${item.text} -> ${item.note ?? ""}`);
      }
    }
  }
  return lines.join("\n");
}

/** Open questions and to-dos, and standing decisions, of topics still live: what a sweep rules on. */
export function itemsToCheck(doc: LedgerDocument) {
  return doc.topics
    .filter((t) => !CLOSED_TOPIC.has(t.status))
    .flatMap((topic) =>
      topic.items
        .filter((i) => i.state === "open" || (i.kind === "decision" && i.state === "recorded"))
        .map((item) => ({ topic, item })),
    );
}

export const liveTopics = (doc: LedgerDocument) =>
  doc.topics.filter((t) => !CLOSED_TOPIC.has(t.status));

const TASK_MARK = { pending: "todo", in_progress: "doing", completed: "done" } as const;

/** Live topics with what is still open and what stands; closed items and finished topics as counts. */
export function renderForAgent(doc: LedgerDocument): string {
  if (!doc.enabled) return "Ledger is off for this thread.";
  const lines = [
    `Ledger after ${doc.turns} turn${doc.turns === 1 ? "" : "s"}${doc.scribing ? " (updating)" : ""}.`,
  ];
  if (doc.lastError) lines.push(`Last update failed: ${doc.lastError}`);
  if (doc.missedTurns) {
    lines.push(
      `${doc.missedTurns} turn${doc.missedTurns === 1 ? "" : "s"} ended while T3 was down and ${doc.missedTurns === 1 ? "was" : "were"} never read.`,
    );
  }
  if (doc.liveTasks.length > 0) {
    lines.push(
      `Task list: ${doc.liveTasks.map((t) => `[${TASK_MARK[t.status]}] ${t.text}`).join("; ")}`,
    );
  }
  for (const topic of liveTopics(doc)) {
    lines.push(`${topic.id} ${topic.name} [${topic.status}]`);
    let closed = 0;
    for (const item of topic.items) {
      if (item.state === "open" && item.kind === "question") {
        lines.push(
          `  question ${item.id}: ${item.text}${item.rec ? ` (Claude recommends: ${item.rec})` : ""}`,
        );
      } else if (item.state === "open" && item.kind === "todo") {
        lines.push(`  to-do ${item.id} (${item.owner ?? "claude"}): ${item.text}`);
      } else if (item.kind === "decision" && item.state === "recorded") {
        lines.push(`  decision ${item.id}: ${item.text}`);
      } else {
        closed += 1;
      }
    }
    if (closed > 0) lines.push(`  ${closed} closed item${closed === 1 ? "" : "s"}`);
  }
  const finished = doc.topics.filter((t) => CLOSED_TOPIC.has(t.status));
  if (finished.length > 0) {
    lines.push(`Finished: ${finished.map((t) => `${t.id} ${t.name} [${t.status}]`).join("; ")}`);
  }
  if (doc.topics.length === 0) lines.push("No topics yet.");
  return lines.join("\n");
}
