import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";

import { checkThreadLedgerItem } from "../../state/ledger";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";

/**
 * Checks off one of the user's own to-dos, or opens it again. Undefined when this connection may
 * not change the thread. The ledger's stream carries the new state.
 */
export function useLedgerCheck(threadRef: ScopedThreadRef) {
  const canOperate = useEnvironmentScope(threadRef.environmentId, AuthOrchestrationOperateScope);
  const command = useAtomCommand(checkThreadLedgerItem, { reportFailure: false });
  const checkItem = async (itemId: string, done: boolean): Promise<void> => {
    const result = await command({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, itemId, done },
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: done ? "Could not check it off" : "Could not reopen it",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    if (!done) return;
    const id = toastManager.add({
      type: "success",
      title: "Checked off",
      actionProps: {
        children: "Undo",
        onClick: () => {
          toastManager.close(id);
          void checkItem(itemId, false);
        },
      },
    });
  };
  return canOperate ? checkItem : undefined;
}
