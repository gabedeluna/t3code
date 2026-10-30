import {
  OrchestratorMcpFailure,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderInstanceConfig,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as LedgerLaunchers from "../../../ledger/LedgerLaunchers.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ClaudeSessionCopy from "../../../provider/Drivers/ClaudeSessionCopy.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { resolveRuntimeMode } from "../../delegatedTaskModes.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  assertFullAccess,
  newCommandId,
  readCaller,
  resolveProjectId,
  unavailable,
} from "../../threadAccess.ts";
import { assertProjectWorktree } from "../project/handlers.ts";
import { ClaudeImportToolkit } from "./tools.ts";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");
const DEFAULT_CLAUDE_INSTANCE = ProviderInstanceId.make("claudeAgent");

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const copyFailure = (
  error:
    | ClaudeSessionCopy.ClaudeSessionNotFoundError
    | ClaudeSessionCopy.ClaudeSessionActiveError
    | ClaudeSessionCopy.ClaudeSessionCopyError,
) =>
  error._tag === "ClaudeSessionCopyError"
    ? new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message })
    : invalid(error.message);

/** The model the copy goes on with: the session's own when the instance offers it. */
const pickModel = (
  models: ReadonlyArray<{ readonly slug: string; readonly isDefault?: boolean | undefined }>,
  sessionModel: string | undefined,
) => {
  const own =
    sessionModel === undefined
      ? undefined
      : (models.find((model) => model.slug === sessionModel) ??
        // Transcripts name dated API models, such as claude-haiku-5-5-20261001.
        models
          .filter((model) => sessionModel.startsWith(`${model.slug}-`))
          .toSorted((left, right) => right.slug.length - left.slug.length)[0]);
  return (own ?? models.find((model) => model.isDefault === true) ?? models[0])?.slug;
};

export const layer = McpToolAccess.toLayer(ClaudeImportToolkit, {
  t3_thread_import_claude: McpToolAccess.startsThreads(
    () => ({}),
    (input, { runtimeMode, interactionMode }) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const context = yield* readCaller();
        // The copy carries the whole conversation, which this caller could then read.
        yield* assertFullAccess(
          context,
          "Importing a Claude Code session reads this machine's transcripts; it needs a full-access/default calling thread or a full-access client.",
        );
        const { caller } = context;
        const fileSystem = yield* FileSystem.FileSystem;
        const projectId = yield* resolveProjectId(context, input.projectId);
        const project = yield* Project.ProjectService.pipe(
          Effect.flatMap((projects) => projects.getById(projectId)),
          Effect.mapError(unavailable),
          Effect.map(Option.getOrUndefined),
        );
        if (project === undefined) return yield* invalid("The project was not found.");
        // A Scratch thread gets a new folder at launch, so the copy would land in the wrong one.
        const scratch = yield* ManagedProjectFolders.ManagedProjectFolders.pipe(
          Effect.flatMap((folders) => folders.isScratchProject(projectId)),
        );
        if (scratch)
          return yield* invalid(
            "A Scratch project gives each thread a new folder; import into another project.",
          );
        const workspaceStrategy = input.workspaceStrategy ?? { type: "root" as const };
        if (workspaceStrategy.type === "existing_worktree")
          yield* assertProjectWorktree(project.workspaceRoot, workspaceStrategy.worktreePath);
        const cwd =
          workspaceStrategy.type === "existing_worktree"
            ? workspaceStrategy.worktreePath
            : project.workspaceRoot;

        const instanceId = input.modelSelection?.instanceId ?? DEFAULT_CLAUDE_INSTANCE;
        const settings = yield* ServerSettings.ServerSettingsService.pipe(
          Effect.flatMap((service) => service.getSettings),
          Effect.mapError(unavailable),
        );
        const instance: ProviderInstanceConfig | undefined =
          settings.providerInstances[instanceId] ??
          (instanceId === DEFAULT_CLAUDE_INSTANCE ? { driver: CLAUDE_DRIVER } : undefined);
        if (instance?.driver !== CLAUDE_DRIVER)
          return yield* invalid(
            "modelSelection.instanceId must name a Claude instance. orchestrator_capabilities lists them.",
          );
        const provider = (yield* ProviderRegistry.ProviderRegistry.pipe(
          Effect.flatMap((registry) => registry.getProviders),
        )).find((candidate) => candidate.instanceId === instanceId);
        if (provider === undefined)
          return yield* new OrchestratorMcpFailure({
            code: "provider_unavailable",
            message: `Provider instance ${instanceId} is not available.`,
          });

        // Claude Code keeps sessions in the host's config home; an instance may keep its own.
        const targetConfigDir = yield* ClaudeSessionCopy.claudeInstanceConfigDir(instance);
        const copy = yield* ClaudeSessionCopy.copyClaudeSession({
          sessionId: input.sessionId,
          sourceConfigDirs: [
            yield* ClaudeSessionCopy.claudeInstanceConfigDir(undefined),
            targetConfigDir,
          ],
          targetConfigDir,
          cwd,
        }).pipe(Effect.mapError(copyFailure));
        const commandId = yield* newCommandId();
        const threadId = ThreadId.make(commandId);
        // Only a thread that never got created leaves its copy unused.
        const discardCopy = Effect.gen(function* () {
          const created = yield* context.threads
            .getThreadShell(threadId)
            .pipe(Effect.orElseSucceed(() => null));
          if (created === null) yield* fileSystem.remove(copy.transcriptPath).pipe(Effect.ignore);
        });

        const model = input.modelSelection?.model ?? pickModel(provider.models, copy.summary.model);
        if (model === undefined) {
          yield* discardCopy;
          return yield* new OrchestratorMcpFailure({
            code: "model_unavailable",
            message: `Provider instance ${instanceId} lists no models.`,
          });
        }
        const modelSelection = input.modelSelection ?? { instanceId, model };
        // A caller outside a thread starts with the project's default mode, as a launch does.
        const startedRuntimeMode =
          caller === undefined
            ? yield* resolveRuntimeMode(
                runtimeMode,
                resolveProjectSettings(settings, projectId, project).settings.defaultRuntimeMode,
              ).pipe(Effect.orElseSucceed(() => runtimeMode))
            : runtimeMode;
        const result = yield* ThreadLaunch.ThreadLaunchService.pipe(
          Effect.flatMap((launches) =>
            launches.launch({
              commandId,
              threadId,
              projectId,
              title:
                input.title ??
                copy.summary.customTitle ??
                copy.summary.aiTitle ??
                "Claude Code session",
              modelSelection,
              runtimeMode: startedRuntimeMode,
              interactionMode,
              workspaceStrategy,
              importedNativeThread: {
                ref: { driver: CLAUDE_DRIVER, nativeId: copy.sessionId, strength: "strong" },
                // A rollback to the thread's start returns to the imported conversation.
                ...(copy.summary.leafUuid === undefined
                  ? {}
                  : { metadata: { forkHeadMessageId: copy.summary.leafUuid } }),
              },
              createdBy: "agent",
              creationSource: "mcp",
            }),
          ),
          Effect.tapError(() => discardCopy),
          Effect.mapError((error) =>
            error._tag === "ThreadManagementProviderInstanceDisabledError"
              ? invalid(error.message)
              : unavailable(),
          ),
        );
        const thread = result.projection.thread;
        yield* LedgerLaunchers.recordLaunch(caller?.id, thread.id);
        return {
          threadId: thread.id,
          link: McpInvocationContext.threadLinkFor(scope, thread.id),
          projectId: thread.projectId,
          modelSelection: thread.modelSelection,
          claudeSessionId: copy.sessionId,
          cwd,
        };
      }),
    { refused: "import a Claude Code session from this machine" },
  ),
});
