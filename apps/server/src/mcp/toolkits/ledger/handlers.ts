import * as Effect from "effect/Effect";

import { renderForAgent } from "../../../ledger/ledgerDocument.ts";
import { renderWorkers } from "../../../ledger/ledgerRollup.ts";
import * as LedgerStore from "../../../ledger/LedgerStore.ts";
import * as LedgerWorkers from "../../../ledger/LedgerWorkers.ts";
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
});
