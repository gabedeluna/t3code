import {
  type LedgerDocument,
  type LedgerItem,
  type LedgerTopic,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { emptyLedger } from "./ledgerDocument.ts";
import { at } from "./ledger.testkit.ts";
import {
  type WorkerShell,
  groupWorkers,
  renderWorkers,
  workerOf,
  workerRuntime,
} from "./ledgerRollup.ts";

const shell = (extra: Partial<WorkerShell> = {}): WorkerShell => ({
  id: ThreadId.make("thread:worker"),
  title: "Stone textures",
  status: "idle",
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  settledOverride: null,
  ...extra,
});

const request = (kind: "user_input" | "command", blocking?: boolean) => ({
  id: RuntimeRequestId.make("request:1"),
  kind,
  createdAt: at,
  ...(blocking === undefined ? {} : { blocking }),
});

const item = (fields: Partial<LedgerItem> & Pick<LedgerItem, "id" | "kind">) =>
  ({ state: "open", text: `About ${fields.id}`, turn: 1, ...fields }) as LedgerItem;

const topic = (fields: Partial<LedgerTopic> & Pick<LedgerTopic, "id" | "name">): LedgerTopic => ({
  status: "active",
  turn: 1,
  items: [],
  ...fields,
});

const ledger = (topics: ReadonlyArray<LedgerTopic>, extra: Partial<LedgerDocument> = {}) => ({
  ...emptyLedger(ThreadId.make("thread:worker"), "2026-10-29T00:00:00.000Z"),
  enabled: true,
  turns: 4,
  topics,
  ...extra,
});

describe("workerRuntime", () => {
  it("reads a request for the user first, then work, then a failure", () => {
    assert.strictEqual(
      workerRuntime(shell({ pendingRuntimeRequest: request("command") })),
      "approval",
    );
    assert.strictEqual(
      workerRuntime(shell({ status: "running", pendingRuntimeRequest: request("user_input") })),
      "input",
    );
    // An async question the run keeps working past is not a wait on the user.
    assert.strictEqual(
      workerRuntime(
        shell({ status: "running", pendingRuntimeRequest: request("user_input", false) }),
      ),
      "working",
    );
    assert.strictEqual(workerRuntime(shell({ status: "queued" })), "working");
    assert.strictEqual(
      workerRuntime(shell({ status: "completed", activityRunStatus: "running" })),
      "working",
    );
    assert.strictEqual(workerRuntime(shell({ status: "failed" })), "failed");
    assert.strictEqual(workerRuntime(shell({ status: "completed" })), "idle");
  });
});

describe("workerOf", () => {
  const doc = ledger([
    topic({
      id: "T1",
      name: "Grab animations",
      status: "review",
      items: [
        item({ id: "t1", kind: "todo", owner: "user", text: "Check the grab in game" }),
        item({ id: "q1", kind: "question", text: "Batch 2 too?", rec: "Yes" }),
        item({ id: "q2", kind: "question", state: "answered", text: "Old" }),
      ],
    }),
    topic({
      id: "T2",
      name: "Trade bump",
      status: "active",
      items: [item({ id: "t2", kind: "todo", owner: "claude", text: "Wire the trade bump" })],
    }),
    topic({ id: "T3", name: "Shelved", status: "done" }),
  ]);

  it("puts an idle worker with an open question under needs you, questions first", () => {
    const worker = workerOf(shell(), doc);
    assert.strictEqual(worker.state, "input");
    assert.strictEqual(worker.group, "needs-you");
    assert.deepStrictEqual(
      worker.needs.map((need) => need.id),
      ["q1", "t1"],
    );
    assert.strictEqual(worker.needCount, 2);
    assert.deepStrictEqual(
      worker.topics.map((t) => [t.id, t.status]),
      [
        ["T2", "active"],
        ["T1", "review"],
      ],
    );
    assert.strictEqual(worker.nextStep, "Wire the trade bump");
  });

  it("keeps a working worker under working, with its task progress", () => {
    const worker = workerOf(
      shell({ status: "running" }),
      ledger(doc.topics, {
        liveTasks: [
          { id: "1", text: "Build", status: "completed" },
          { id: "2", text: "Test", status: "in_progress" },
          { id: "3", text: "Ship", status: "pending" },
        ],
      }),
    );
    assert.strictEqual(worker.state, "working");
    assert.strictEqual(worker.group, "working");
    assert.deepStrictEqual(worker.tasks, { done: 1, total: 3, current: "Test" });
  });

  it("calls a user to-do or a topic in review a review, and a finished ledger done", () => {
    const review = ledger([topic({ id: "T1", name: "Landing", status: "review" })]);
    assert.strictEqual(workerOf(shell(), review).state, "review");
    const finished = ledger([topic({ id: "T1", name: "Landing", status: "done" })]);
    assert.deepStrictEqual(
      [workerOf(shell(), finished).state, workerOf(shell(), finished).group],
      ["done", "quiet"],
    );
  });

  it("calls a worker done when its last turn finished and nothing is open, ledger or not", () => {
    const off = ledger([], { enabled: false });
    assert.strictEqual(workerOf(shell({ status: "completed" }), off).state, "done");
    const live = ledger([topic({ id: "T1", name: "Landing", status: "active" })]);
    assert.strictEqual(workerOf(shell({ status: "completed" }), live).state, "idle");
  });

  it("files a settled thread as settled unless it is waiting on the user", () => {
    assert.strictEqual(workerOf(shell({ settledOverride: "settled" }), doc).group, "settled");
    assert.strictEqual(
      workerOf(
        shell({ settledOverride: "settled", pendingRuntimeRequest: request("command") }),
        doc,
      ).group,
      "needs-you",
    );
  });

  it("reads nothing from a ledger that is off", () => {
    const worker = workerOf(shell(), ledger(doc.topics, { enabled: false }));
    assert.deepStrictEqual(
      [worker.state, worker.group, worker.ledgerEnabled, worker.needs, worker.topics],
      ["idle", "quiet", false, [], []],
    );
    assert.isUndefined(worker.nextStep);
  });

  it("carries the error of a failed worker", () => {
    const worker = workerOf(shell({ status: "failed", lastError: "Usage limit" }), ledger([]));
    assert.deepStrictEqual(
      [worker.state, worker.group, worker.lastError],
      ["failed", "needs-you", "Usage limit"],
    );
  });
});

describe("renderWorkers", () => {
  const ids = (n: number) => ThreadId.make(`thread:w${n}`);
  const workers = [
    workerOf(
      shell({ id: ids(1), title: "Hit reactions", status: "running" }),
      ledger(
        [
          topic({
            id: "T2",
            name: "Grab and trade animations",
            items: [item({ id: "t4", kind: "todo", owner: "claude", text: "Wire the trade bump" })],
          }),
        ],
        {
          liveTasks: [
            { id: "1", text: "a", status: "completed" },
            { id: "2", text: "b", status: "pending" },
          ],
        },
      ),
    ),
    workerOf(
      shell({ id: ids(2), title: "Stone textures T.2" }),
      ledger([
        topic({
          id: "T1",
          name: "Stone textures",
          items: [
            item({ id: "q3", kind: "question", text: "Approve stone batch 2?", rec: "Approve it" }),
            item({ id: "q4", kind: "question", text: "Tone chert down?" }),
          ],
        }),
      ]),
    ),
    workerOf(
      shell({ id: ids(3), title: "Second dev client spike" }),
      ledger([], { enabled: false }),
    ),
    workerOf(shell({ id: ids(4), title: "Old spike", settledOverride: "settled" }), ledger([])),
  ];

  it("groups the workers: needs you, working, quiet, then settled", () => {
    assert.deepStrictEqual(
      groupWorkers(workers).map((g) => [g.label, g.workers.map((w) => w.title)]),
      [
        ["Needs you", ["Stone textures T.2"]],
        ["Working", ["Hit reactions"]],
        ["Quiet", ["Second dev client spike"]],
        ["Settled", ["Old spike"]],
      ],
    );
  });

  it("writes one short block per worker, with its thread id", () => {
    assert.strictEqual(
      renderWorkers("7 days Director", workers),
      [
        "Workers of 7 days Director: 4, from their ledgers.",
        "Needs you (1):",
        "- Stone textures T.2 [input] thread:w2",
        "  question q3 (Stone textures): Approve stone batch 2? Claude recommends: Approve it; +1 more",
        "Working (1):",
        "- Hit reactions [working] thread:w1",
        "  T2 Grab and trade animations [active]; next: Wire the trade bump; tasks 1/2",
        "Quiet (1):",
        "- Second dev client spike [idle] thread:w3",
        "  ledger off",
        "Settled (1): Old spike",
      ].join("\n"),
    );
  });

  it("says so when the thread launched no workers", () => {
    assert.match(renderWorkers("Telify", []), /^Telify has launched no workers/);
  });
});
