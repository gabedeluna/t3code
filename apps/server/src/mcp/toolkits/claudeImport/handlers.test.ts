import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ThreadShell,
  type Project as ProjectRecord,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as Project from "../../../project/ProjectService.ts";
import { claudeProjectSlug } from "../../../provider/Drivers/ClaudeSessionCopy.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ClaudeImportHandlers from "./handlers.ts";
import { ClaudeImportToolkit } from "./tools.ts";

const SOURCE_ID = "5d2c8a41-7b3e-4f6a-9c1d-2e4f6a8b0c1d";
const projectId = ProjectId.make("project:claude-import");
const encodeLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
// The test clock reads this; transcripts are dated back from it.
const NOW_MS = 1_767_225_600_000;

const transcript = [
  { type: "ai-title", aiTitle: "Pelican memory", sessionId: SOURCE_ID },
  {
    type: "user",
    uuid: "u-1",
    sessionId: SOURCE_ID,
    message: { role: "user", content: "Remember the word PELICAN. Reply ok." },
  },
  {
    type: "assistant",
    uuid: "a-1",
    parentUuid: "u-1",
    sessionId: SOURCE_ID,
    message: { role: "assistant", model: "claude-haiku-5-5-20261001", content: "ok" },
  },
]
  .map((line) => `${encodeLine(line)}\n`)
  .join("");

const providers = [
  {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    models: [
      { slug: "claude-opus-5-5", isDefault: true },
      { slug: "claude-haiku-5-5", isDefault: false },
    ],
  },
  {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    models: [{ slug: "gpt-6.1-sol", isDefault: true }],
  },
] as unknown as ReadonlyArray<ServerProvider>;

/** A Claude config home with the source session, a project checkout and one extra worktree. */
const setup = Effect.fn("test.setup")(function* (options?: { readonly ageMs?: number }) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-import-config-" });
  const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-import-root-" });
  const worktree = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-import-worktree-" });
  const sourcePath = path.join(configDir, "projects", "-somewhere-else", `${SOURCE_ID}.jsonl`);
  yield* fileSystem.makeDirectory(path.dirname(sourcePath), { recursive: true });
  yield* fileSystem.writeFileString(sourcePath, transcript);
  yield* TestClock.setTime(NOW_MS);
  // Numbers are seconds to utimes.
  const writtenAtSeconds = (NOW_MS - (options?.ageMs ?? 5 * 60_000)) / 1000;
  yield* fileSystem.utimes(sourcePath, writtenAtSeconds, writtenAtSeconds);
  const projectsDir = path.join(configDir, "projects");
  const copiesIn = Effect.fn("test.copiesIn")(function* (cwd: string) {
    const real = (yield* fileSystem.realPath(cwd)).normalize("NFC");
    const folder = path.join(projectsDir, claudeProjectSlug(real));
    return (yield* fileSystem.exists(folder)) ? yield* fileSystem.readDirectory(folder) : [];
  });
  return { configDir, workspaceRoot, worktree, sourcePath, copiesIn };
});

const harness = (input: {
  readonly configDir: string;
  readonly workspaceRoot: string;
  readonly worktree: string;
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly access?: RuntimeMode;
  readonly scratch?: boolean;
  readonly launchFails?: boolean;
}) =>
  Layer.mergeAll(
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session-1",
      thread: undefined,
      client: {
        sessionId: "session-1",
        label: "Claude Code",
        access: input.access ?? "full-access",
      },
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => {
        const launch = input.launched.find((candidate) => candidate.threadId === threadId);
        return Effect.succeed(
          launch === undefined || input.launchFails === true
            ? null
            : ({ id: threadId, deletedAt: null } as unknown as OrchestrationV2ThreadShell),
        );
      },
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      launch: (launch) => {
        input.launched.push(launch);
        return input.launchFails === true
          ? Effect.fail(
              new ThreadLaunch.ThreadLaunchError({
                operation: "resolve-project",
                commandId: launch.commandId,
                projectId: launch.projectId,
                cause: "test",
              }),
            )
          : Effect.succeed({
              threadId: launch.threadId,
              projection: {
                thread: {
                  id: launch.threadId,
                  projectId: launch.projectId,
                  modelSelection: launch.modelSelection,
                },
                runs: [],
              },
              resumed: false,
            } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id,
                workspaceRoot: input.workspaceRoot,
                defaultModelSelection: null,
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
    }),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      isScratchProject: () => Effect.succeed(input.scratch === true),
    }),
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      listWorktreePaths: () => Effect.succeed([input.workspaceRoot, input.worktree]),
    }),
    ServerSettings.layerTest({ defaultRuntimeMode: "auto-accept-edits" }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
    Layer.succeed(HostProcess.Environment, { CLAUDE_CONFIG_DIR: input.configDir }),
    NodeCrypto.layer,
  ).pipe(Layer.provideMerge(NodeServices.layer));

const callImport = Effect.fn("test.callImport")(function* (
  dependencies: ReturnType<typeof harness>,
  params: Record<string, unknown>,
) {
  const toolkit = yield* ClaudeImportToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(ClaudeImportHandlers.layer).pipe(
        Layer.provide(dependencies),
      ),
    ),
  );
  const result = yield* toolkit
    .handle("t3_thread_import_claude", params as never)
    .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
  return result.at(-1)?.result as Record<string, unknown> | undefined;
});

it.effect(
  "imports a quiet session into the project root, on the copy and the session's model",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const files = yield* setup();
        const before = yield* fileSystem.readFile(files.sourcePath);
        const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
        const result = yield* callImport(harness({ ...files, launched }), {
          sessionId: SOURCE_ID,
          projectId,
        });

        const launch = launched[0];
        assert.isDefined(launch);
        assert.equal(result?.threadId, launch?.threadId);
        assert.equal(result?.cwd, files.workspaceRoot);
        assert.notEqual(result?.claudeSessionId, SOURCE_ID);
        assert.deepEqual(launch?.importedNativeThread, {
          ref: {
            driver: ProviderDriverKind.make("claudeAgent"),
            nativeId: result?.claudeSessionId as string,
            strength: "strong",
          },
          metadata: { forkHeadMessageId: "a-1" },
        });
        assert.deepEqual(launch?.workspaceStrategy, { type: "root" });
        assert.deepEqual(launch?.modelSelection, {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-haiku-5-5",
        });
        assert.equal(launch?.title, "Pelican memory");
        // A client outside a thread starts with the project's default mode.
        assert.equal(launch?.runtimeMode, "auto-accept-edits");
        assert.isUndefined(launch?.initialMessage);
        assert.deepEqual(yield* files.copiesIn(files.workspaceRoot), [
          `${result?.claudeSessionId as string}.jsonl`,
        ]);
        assert.deepEqual(yield* fileSystem.readFile(files.sourcePath), before);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("binds an existing project worktree and copies the session into its folder", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const files = yield* setup();
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const dependencies = harness({ ...files, launched });
      const result = yield* callImport(dependencies, {
        sessionId: SOURCE_ID,
        projectId,
        title: "Carry on",
        workspaceStrategy: { type: "existing_worktree", worktreePath: files.worktree },
        modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      });
      assert.equal(result?.cwd, files.worktree);
      assert.equal(launched[0]?.title, "Carry on");
      assert.equal(launched[0]?.modelSelection.model, "claude-opus-5-5");
      assert.deepEqual(yield* files.copiesIn(files.worktree), [
        `${result?.claudeSessionId as string}.jsonl`,
      ]);
      assert.deepEqual(yield* files.copiesIn(files.workspaceRoot), []);

      const elsewhere = yield* callImport(dependencies, {
        sessionId: SOURCE_ID,
        projectId,
        workspaceStrategy: { type: "existing_worktree", worktreePath: files.configDir },
      });
      assert.equal(elsewhere?.code, "invalid_request");
      assert.lengthOf(launched, 1);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "refuses an open session, a non-Claude instance, a Scratch project and a limited caller",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const quiet = yield* setup();
        const open = yield* setup({ ageMs: 5_000 });
        const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
        const params = { sessionId: SOURCE_ID, projectId };

        const active = yield* callImport(harness({ ...open, launched }), params);
        assert.equal(active?.code, "invalid_request");
        assert.include(active?.message as string, "Close it in Claude Code");

        const codex = yield* callImport(harness({ ...quiet, launched }), {
          ...params,
          modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
        });
        assert.equal(codex?.code, "invalid_request");

        const scratch = yield* callImport(harness({ ...quiet, launched, scratch: true }), params);
        assert.equal(scratch?.code, "invalid_request");

        const limited = yield* callImport(
          harness({ ...quiet, launched, access: "approval-required" }),
          params,
        );
        assert.equal(limited?.code, "capability_denied");

        const missing = yield* callImport(harness({ ...quiet, launched }), {
          ...params,
          sessionId: "6e3d9b52-8c4f-4a7b-8d2e-3f5a7b9c1d2e",
        });
        assert.equal(missing?.code, "invalid_request");

        assert.lengthOf(launched, 0);
        assert.deepEqual(yield* quiet.copiesIn(quiet.workspaceRoot), []);
        assert.deepEqual(yield* open.copiesIn(open.workspaceRoot), []);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("removes the copy when no thread was created", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const files = yield* setup();
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const result = yield* callImport(harness({ ...files, launched, launchFails: true }), {
        sessionId: SOURCE_ID,
        projectId,
      });
      assert.equal(result?.code, "orchestration_error");
      assert.lengthOf(launched, 1);
      assert.deepEqual(yield* files.copiesIn(files.workspaceRoot), []);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
