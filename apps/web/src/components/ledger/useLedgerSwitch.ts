import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { setThreadLedgerEnabled } from "../../state/ledger";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Turns the thread's ledger on or off. Failures toast; the ledger's stream carries the new state. */
export function useLedgerSwitch(threadRef: ScopedThreadRef) {
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const command = useAtomCommand(setThreadLedgerEnabled, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const setEnabled = async (enabled: boolean) => {
    if (!canOperate || pending) return;
    setPending(true);
    const result = await command({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, enabled },
    });
    setPending(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: enabled ? "Could not turn the ledger on" : "Could not turn the ledger off",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  return { setEnabled, canOperate, pending };
}
