import {
  LedgerItemKind,
  LedgerTopicStatus,
  OrchestratorMcpFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as LedgerStore from "../../../ledger/LedgerStore.ts";
import * as LedgerWorkers from "../../../ledger/LedgerWorkers.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

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

const ItemRef = Schema.String.annotate({ description: "An item id from t3_ledger_read, e.g. q3." });
const TopicRef = Schema.String.annotate({ description: "A topic id, e.g. T2, or its name." });

// Touches only the caller's own ledger, never its workspace, so read-only sandboxes and plan
// mode may use it. Only the user switches a ledger on.
const LedgerUpdateTool = Tool.make("t3_ledger_update", {
  description:
    "Correct this thread's ledger. T3 updates it after each turn, so use this when it is wrong or missing something: close what is settled, add what it lacks, move a topic's status, reword or refile an item.",
  parameters: Schema.Struct({
    closes: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          item: ItemRef,
          state: Schema.Literals(["answered", "done", "dropped"]),
          note: Schema.String.annotate({ description: "What settled it, one short line." }),
        }),
      ),
    ),
    adds: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          topic: Schema.String.annotate({
            description: "A topic id, e.g. T2, or its name. A new name opens a topic.",
          }),
          kind: LedgerItemKind.annotate({
            description: "A decision is only what the user chose, never your own plan.",
          }),
          text: Schema.String,
          owner: Schema.optionalKey(
            Schema.Literals(["claude", "user"]).annotate({
              description: "Who does a to-do: claude (you, the default) or the user.",
            }),
          ),
          rec: Schema.optionalKey(
            Schema.String.annotate({ description: "Your recommendation, for a question." }),
          ),
        }),
      ),
    ),
    statuses: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          topic: TopicRef,
          status: LedgerTopicStatus.annotate({
            description: "review: built, waiting on the user's check. hold: paused.",
          }),
        }),
      ),
    ),
    revisions: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          item: ItemRef,
          text: Schema.optionalKey(Schema.String),
          topic: Schema.optionalKey(TopicRef),
        }),
      ),
    ),
  }),
  success: Schema.Struct({
    applied: Schema.Array(Schema.String),
    skipped: Schema.Array(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    LedgerStore.LedgerStore,
  ],
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

export const LedgerToolkit = Toolkit.make(LedgerReadTool, LedgerWorkersTool, LedgerUpdateTool);
