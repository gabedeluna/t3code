import {
  ModelSelection,
  OrchestratorMcpFailure,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const ThreadImportClaudeTool = Tool.make("t3_thread_import_claude", {
  description:
    "Copy a Claude Code CLI session into a new idle thread that resumes the copy; the original is only read. Close it in Claude Code first, or the two diverge: one written in the last 60 s is refused. Modes inherit yours. Then `t3_thread_send`.",
  parameters: Schema.Struct({
    sessionId: TrimmedNonEmptyString.annotate({
      description: "Its .jsonl name under ~/.claude/projects/<folder>/.",
    }),
    projectId: Schema.optional(ProjectId),
    workspaceStrategy: Schema.optional(
      Schema.Union([
        Schema.Struct({ type: Schema.Literal("root") }),
        Schema.Struct({
          type: Schema.Literal("existing_worktree"),
          worktreePath: TrimmedNonEmptyString,
          branch: Schema.optional(TrimmedNonEmptyString),
        }),
      ]).annotate({
        description:
          "'root': the project checkout, the default. 'existing_worktree': `worktreePath`, a project worktree.",
      }),
    ),
    title: Schema.optional(TrimmedNonEmptyString),
    modelSelection: Schema.optional(
      ModelSelection.annotate({
        description: "A Claude instance. Default: claudeAgent, with the session's last model.",
      }),
    ),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    link: Schema.optional(Schema.String),
    projectId: ProjectId,
    modelSelection: ModelSelection,
    /** The copy's session id; the original keeps its own. */
    claudeSessionId: Schema.String,
    cwd: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadLaunchService.ThreadLaunchService,
    ProjectService.ProjectService,
    ManagedProjectFolders.ManagedProjectFolders,
    GitVcsDriver.GitVcsDriver,
    ServerSettings.ServerSettingsService,
    ProviderRegistry.ProviderRegistry,
    FileSystem.FileSystem,
    Path.Path,
    Crypto.Crypto,
  ],
})
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

export const ClaudeImportToolkit = Toolkit.make(ThreadImportClaudeTool);
