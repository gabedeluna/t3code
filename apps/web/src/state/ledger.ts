import { useAtomValue } from "@effect/atom-react";
import {
  type LedgerDocument,
  type LedgerWorker,
  type ScopedThreadRef,
  WS_METHODS,
} from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";

/** The thread's ledger now, then each change the scribe or the switch makes. */
const threadLedger = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:thread-ledger",
  tag: WS_METHODS.subscribeThreadLedger,
});

export const setThreadLedgerEnabled = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:thread-ledger:set-enabled",
  tag: WS_METHODS.setThreadLedgerEnabled,
});

export interface ThreadLedgerView {
  /** Null until the first document arrives, or while the environment is unreachable. */
  readonly ledger: LedgerDocument | null;
  readonly error: string | null;
}

export function useThreadLedger(threadRef: ScopedThreadRef | null): ThreadLedgerView {
  const query = useEnvironmentQuery(
    threadRef === null
      ? null
      : threadLedger({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
  );
  return { ledger: query.data, error: query.error };
}

/** The threads this thread launched, from their ledgers and status, now and on each change. */
const threadWorkers = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:thread-workers",
  tag: WS_METHODS.subscribeThreadWorkers,
});

const NO_WORKERS: ReadonlyArray<LedgerWorker> = [];

/** Empty until the first rollup arrives, and for a thread that launched none. */
export function useThreadWorkers(threadRef: ScopedThreadRef | null): ReadonlyArray<LedgerWorker> {
  const query = useEnvironmentQuery(
    threadRef === null
      ? null
      : threadWorkers({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        }),
  );
  return query.data?.workers ?? NO_WORKERS;
}

export interface LedgerScribeSettings {
  readonly turnModel: string;
  readonly sweepModel: string;
  readonly sweepEvery: number;
}

const DEFAULT_LEDGER_SCRIBE_SETTINGS: LedgerScribeSettings = {
  turnModel: "haiku",
  sweepModel: "sonnet",
  sweepEvery: 8,
};

/** The scribe's models and cadence on the thread's environment, for the panel's footer. */
export function useLedgerScribeSettings(threadRef: ScopedThreadRef): LedgerScribeSettings {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(threadRef.environmentId));
  if (!settings) return DEFAULT_LEDGER_SCRIBE_SETTINGS;
  return {
    turnModel: settings.ledgerTurnModel,
    sweepModel: settings.ledgerSweepModel,
    sweepEvery: settings.ledgerSweepEvery,
  };
}
