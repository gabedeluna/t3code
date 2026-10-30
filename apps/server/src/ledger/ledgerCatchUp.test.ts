import type { LedgerDocument, OrchestrationV2Run } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { type CatchUpRun, missedRuns } from "./ledgerCatchUp.ts";
import { emptyLedger } from "./ledgerDocument.ts";
import { ledgerThreadId, runIdOf } from "./ledger.testkit.ts";

const ended = (minute: number) =>
  DateTime.makeUnsafe(`2026-10-29T10:${String(minute).padStart(2, "0")}:00.000Z`);

const runOf = (
  n: number,
  status: OrchestrationV2Run["status"] = "completed",
  minute: number | null = n,
): CatchUpRun => ({
  id: runIdOf(n),
  ordinal: n,
  status,
  completedAt: minute === null ? null : ended(minute),
});

const ledger = (extra: Partial<LedgerDocument>): LedgerDocument => ({
  ...emptyLedger(ledgerThreadId, "2026-10-29T00:00:00.000Z"),
  enabled: true,
  ...extra,
});

const ids = (n: ReadonlyArray<number>) => n.map(runIdOf);

describe("missedRuns", () => {
  it("reads nothing for a ledger that is off", () => {
    const off = ledger({ enabled: false, lastRunId: runIdOf(1) });
    assert.deepStrictEqual(missedRuns(off, [runOf(1), runOf(2)]), { runIds: [], skipped: 0 });
  });

  it("takes the finished runs after the last one read, oldest first", () => {
    const doc = ledger({ lastRunId: runIdOf(2) });
    const runs = [runOf(4, "failed"), runOf(1), runOf(3, "interrupted"), runOf(2)];
    assert.deepStrictEqual(missedRuns(doc, runs), { runIds: ids([3, 4]), skipped: 0 });
  });

  it("keeps only the newest few and counts the rest as skipped", () => {
    const doc = ledger({ lastRunId: runIdOf(1) });
    const runs = Array.from({ length: 12 }, (_, i) => runOf(i + 1));
    assert.deepStrictEqual(missedRuns(doc, runs, 8), {
      runIds: ids([5, 6, 7, 8, 9, 10, 11, 12]),
      skipped: 3,
    });
  });

  it("stops at a run still under way, and passes over cancelled and rolled-back runs", () => {
    const doc = ledger({ lastRunId: runIdOf(1) });
    const runs = [
      runOf(1),
      runOf(2),
      runOf(3, "cancelled", null),
      runOf(4, "rolled_back"),
      runOf(5),
      runOf(6, "running", null),
      runOf(7),
    ];
    assert.deepStrictEqual(missedRuns(doc, runs), { runIds: ids([2, 5]), skipped: 0 });
  });

  it("never reads a run that ended before the ledger was switched on", () => {
    const fresh = ledger({ enabledAt: "2026-10-29T10:03:30.000Z" });
    assert.deepStrictEqual(missedRuns(fresh, [runOf(2), runOf(3), runOf(4), runOf(5)]), {
      runIds: ids([4, 5]),
      skipped: 0,
    });
    // Switched off after run 2, on again after run 4: runs 3 and 4 ran while it was off.
    const again = ledger({ lastRunId: runIdOf(2), enabledAt: "2026-10-29T10:04:30.000Z" });
    assert.deepStrictEqual(missedRuns(again, [runOf(2), runOf(3), runOf(4), runOf(5)]), {
      runIds: ids([5]),
      skipped: 0,
    });
  });

  it("reads nothing without a safe place to start from", () => {
    const runs = [runOf(1), runOf(2)];
    assert.deepStrictEqual(missedRuns(ledger({}), runs).runIds, []);
    assert.deepStrictEqual(missedRuns(ledger({ lastRunId: "run:gone" }), runs).runIds, []);
  });
});
