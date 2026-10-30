import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { renderForAgent } from "../../../ledger/ledgerDocument.ts";
import { renderWorkers } from "../../../ledger/ledgerRollup.ts";
import * as LedgerStore from "../../../ledger/LedgerStore.ts";
import * as LedgerWorkers from "../../../ledger/LedgerWorkers.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readThread } from "../../threadAccess.ts";
import { LedgerToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(LedgerToolkit, {
  t3_ledger_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId);
      const store = yield* LedgerStore.LedgerStore;
      return { ledger: renderForAgent(yield* store.get(projection.thread.id)) };
    }),
  ),
  t3_ledger_workers: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { projection } = yield* readThread(input.threadId);
      const workers = yield* LedgerWorkers.LedgerWorkers;
      const { thread } = projection;
      return { workers: renderWorkers(thread.title, (yield* workers.rollup(thread.id)).workers) };
    }),
  ),
  t3_ledger_update: McpToolAccess.actsAsCaller((edits) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "t3_ledger_update");
      const store = yield* LedgerStore.LedgerStore;
      const change = yield* store.edit(thread.threadId, edits);
      if (Option.isNone(change)) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "This thread's ledger is off. Only the user can switch it on.",
        });
      }
      return change.value;
    }),
  ),
});
