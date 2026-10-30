import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as LedgerStore from "../../../ledger/LedgerStore.ts";
import * as LedgerWorkers from "../../../ledger/LedgerWorkers.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// Read-only on purpose: the ledger is kept by its scribe, and only the user switches it on.
const LedgerReadTool = Tool.make("t3_ledger_read", {
  description:
    "Read a thread's ledger: topics and their status, open questions, open to-dos, standing decisions, its task list. Omit `threadId` for this thread.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({ ledger: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    LedgerStore.LedgerStore,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const LedgerWorkersTool = Tool.make("t3_ledger_workers", {
  description:
    "Where each thread you launched with t3_thread_launch stands, from its ledger and status: grouped needs you, working, quiet. Omit `threadId` for yours.",
  parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({ workers: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    LedgerWorkers.LedgerWorkers,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const LedgerToolkit = Toolkit.make(LedgerReadTool, LedgerWorkersTool);
