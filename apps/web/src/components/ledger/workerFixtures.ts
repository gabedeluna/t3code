import { type LedgerWorker, ThreadId } from "@t3tools/contracts";

const worker = (
  id: string,
  fields: Partial<LedgerWorker> & Pick<LedgerWorker, "title" | "state" | "group">,
): LedgerWorker => ({
  threadId: ThreadId.make(`thread-${id}`),
  ledgerEnabled: true,
  needs: [],
  needCount: 0,
  topics: [],
  ...fields,
});

/** The approved mockup's Director: six workers across the groups, and two settled. */
export const DIRECTOR_WORKERS: ReadonlyArray<LedgerWorker> = [
  worker("stone", {
    title: "Stone textures T.2",
    state: "input",
    group: "needs-you",
    needs: [
      {
        id: "q3",
        kind: "question",
        text: "Approve stone batch 2 (slate, phyllite, chert)?",
        rec: "Approve it",
        topic: "Stone textures",
      },
    ],
    needCount: 1,
    topics: [{ id: "T1", name: "Stone textures", status: "review" }],
  }),
  worker("tenant", {
    title: "Tenant isolation landing",
    state: "review",
    group: "needs-you",
    needs: [
      {
        id: "t4",
        kind: "todo",
        text: "Check the two editors in dev:prod once the build lands",
        topic: "Tenant isolation",
      },
    ],
    needCount: 2,
    topics: [{ id: "T1", name: "Tenant isolation", status: "review" }],
  }),
  worker("hits", {
    title: "Hit reactions",
    state: "working",
    group: "working",
    topics: [{ id: "T2", name: "Grab and trade animations", status: "active" }],
    nextStep: "Wire the trade bump",
    tasks: { done: 3, total: 5, current: "Blend the grab" },
  }),
  worker("perf", {
    title: "Perf 2",
    state: "working",
    group: "working",
    topics: [{ id: "T1", name: "Fight-scene CPU cost", status: "active" }],
    nextStep: "Re-measure after fix 4",
    tasks: { done: 2, total: 4 },
  }),
  worker("moon", {
    title: "Night moonlight",
    state: "done",
    group: "quiet",
  }),
  worker("spike", {
    title: "Second dev client spike",
    state: "idle",
    group: "quiet",
    ledgerEnabled: false,
  }),
  worker("old-1", { title: "Old save format", state: "done", group: "settled" }),
  worker("old-2", { title: "Mod loader swap", state: "idle", group: "settled" }),
];
