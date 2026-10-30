import {
  type LedgerDocument,
  type LedgerItem,
  type LedgerTopic,
  ThreadId,
} from "@t3tools/contracts";

const threadId = ThreadId.make("thread-ledger");
const updatedAt = "2026-10-30T01:09:38.374Z";

/** A ledger nobody switched on: what the server sends for a thread without one. */
export const OFF_LEDGER: LedgerDocument = {
  threadId,
  enabled: false,
  topics: [],
  next: {},
  turns: 0,
  sweptTurn: 0,
  liveTasks: [],
  costUsd: 0,
  updatedAt,
};

/** A real ledger from a settled test thread: one done topic holding one answered question. */
export const SETTLED_LEDGER: LedgerDocument = {
  threadId,
  enabled: true,
  topics: [
    {
      id: "T1",
      name: "Scripts folder cleanup",
      status: "done",
      turn: 1,
      items: [
        {
          id: "q1",
          kind: "question",
          state: "answered",
          text: "Split scripts/check-tenant-guards.ts (about 98 KB) into smaller modules, keeping the same exports and entry point, and run the tenant-guard self-tests?",
          rec: "Yes: split it and run the existing self-tests to confirm nothing broke",
          note: "turn 3: the user said no, don't split check-tenant-guards.ts; leave it as is",
          turn: 2,
          closedTurn: 3,
        },
      ],
    },
  ],
  next: { T: 2, q: 2, d: 1, t: 1 },
  turns: 3,
  sweptTurn: 0,
  liveTasks: [],
  costUsd: 0.0030211400000000003,
  lastRunId: "run:thread:mcp%3A79e7e53b-415f-4543-88aa-aae29b8f96f7:ordinal:4",
  updatedAt,
};

const item = (
  fields: Partial<LedgerItem> & Pick<LedgerItem, "id" | "kind" | "text">,
): LedgerItem => ({
  state: fields.kind === "decision" ? "recorded" : "open",
  turn: 30,
  ...fields,
});

const topic = (
  fields: Pick<LedgerTopic, "id" | "name" | "status"> & { items?: LedgerItem[] },
): LedgerTopic => ({ turn: 20, items: [], ...fields });

/** A busy thread, as the approved mockups draw it. */
export const BUSY_LEDGER: LedgerDocument = {
  threadId,
  enabled: true,
  topics: [
    topic({
      id: "T5",
      name: "Second dev client",
      status: "hold",
    }),
    topic({
      id: "T2",
      name: "Skills and XP, milestone 1",
      status: "chosen",
      items: [
        item({
          id: "q4",
          kind: "question",
          text: "Start milestone 1 now, or re-time the horde first?",
          rec: "Re-time the horde first.",
        }),
        item({ id: "d6", kind: "decision", text: "XP comes from kills and crafting only" }),
        item({ id: "t7", kind: "todo", owner: "claude", text: "Draft the skill tree data file" }),
      ],
    }),
    topic({
      id: "T1",
      name: "Attack slots",
      status: "active",
      items: [
        item({ id: "d1", kind: "decision", text: "Six attack slots, two swinging at once" }),
        item({
          id: "d2",
          kind: "decision",
          text: "A freed slot rests 0.5 s before the next zombie takes it",
        }),
        item({
          id: "t1",
          kind: "todo",
          owner: "claude",
          text: "Wire slot claims into the horde director",
        }),
        item({
          id: "t2",
          kind: "todo",
          owner: "user",
          text: "Watch a 50-zombie horde and say if the swings read",
        }),
        item({
          id: "t3",
          kind: "todo",
          owner: "claude",
          state: "done",
          text: "Measure the 30 and 50 zombie scenes",
          note: "14 ms at 50 zombies",
          closedTurn: 38,
        }),
        item({
          id: "d3",
          kind: "decision",
          state: "dropped",
          text: "Four attack slots",
          closedTurn: 35,
        }),
      ],
    }),
    topic({
      id: "T3",
      name: "Fight-scene CPU cost",
      status: "review",
      items: [
        item({
          id: "q2",
          kind: "question",
          text: "Was OBS or Dying Light running during the demo?",
        }),
      ],
    }),
    topic({ id: "T4", name: "Old save format", status: "done" }),
    topic({ id: "T6", name: "Mod loader swap", status: "rejected" }),
  ],
  next: { T: 7, q: 5, d: 7, t: 8 },
  turns: 41,
  sweptTurn: 40,
  liveTasks: [
    { id: "1", text: "Read the horde director", status: "completed" },
    { id: "2", text: "Add slot claims", status: "in_progress" },
    { id: "3", text: "Run the horde test scene", status: "pending" },
  ],
  costUsd: 0.31,
  updatedAt,
};
