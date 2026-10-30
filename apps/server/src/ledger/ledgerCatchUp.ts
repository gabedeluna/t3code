import type { LedgerDocument, OrchestrationV2Run, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Missed runs read after a restart, newest kept: a long outage can't run up the scribe's cost. */
const CATCH_UP_LIMIT = 8;

const SCRIBED = new Set<OrchestrationV2Run["status"]>(["completed", "failed", "interrupted"]);
const SETTLED = new Set<OrchestrationV2Run["status"]>([...SCRIBED, "cancelled", "rolled_back"]);

export type CatchUpRun = Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "completedAt">;

export interface CatchUp {
  /** Oldest first. */
  readonly runIds: ReadonlyArray<RunId>;
  /** Missed runs older than the ones kept, never read. */
  readonly skipped: number;
}

const none: CatchUp = { runIds: [], skipped: 0 };

/**
 * The finished runs a ledger never read: after the last run it read, and ended since it was
 * switched on. It stops at a run still under way, whose live update comes later and must not find
 * newer runs already read. Nothing when it is off, or when it has neither mark to start from.
 */
export function missedRuns(
  doc: LedgerDocument,
  runs: ReadonlyArray<CatchUpRun>,
  limit = CATCH_UP_LIMIT,
): CatchUp {
  if (!doc.enabled) return none;
  const sorted = runs.toSorted((a, b) => a.ordinal - b.ordinal);
  const last =
    doc.lastRunId === undefined ? undefined : sorted.find((run) => run.id === doc.lastRunId);
  // A last run that is gone (rolled back) leaves no safe place to start from.
  if (doc.lastRunId !== undefined && last === undefined) return none;
  if (last === undefined && doc.enabledAt === undefined) return none;
  const enabledAt = doc.enabledAt === undefined ? undefined : DateTime.makeUnsafe(doc.enabledAt);
  // Runs while it was off are not missed; a run with no end yet ends after it was switched on.
  const after = (run: CatchUpRun) =>
    (last === undefined || run.ordinal > last.ordinal) &&
    (enabledAt === undefined ||
      run.completedAt === null ||
      DateTime.isGreaterThan(run.completedAt, enabledAt));
  const missed: RunId[] = [];
  for (const run of sorted) {
    if (!after(run)) continue;
    if (!SETTLED.has(run.status)) break;
    if (SCRIBED.has(run.status)) missed.push(run.id);
  }
  return {
    runIds: missed.slice(-limit),
    skipped: Math.max(0, missed.length - limit),
  };
}
