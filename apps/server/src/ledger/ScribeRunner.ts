import { ClaudeSettings, ProviderInstanceId, type ServerSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  hasClaudeManagedMcpConfig,
  makeClaudeEnvironment,
} from "../provider/Drivers/ClaudeHome.ts";
import * as ServerSettingsService from "../serverSettings.ts";

/** One structured-output call to a Claude model, with nothing of the user's setup loaded. */
export interface ScribeCall {
  /** A Claude CLI model alias or id, such as "haiku". */
  readonly model: string;
  readonly systemPrompt: string;
  readonly prompt: string;
  readonly schema: object;
}

export interface ScribeResult {
  readonly output: unknown;
  readonly costUsd: number;
}

export class ScribeRunnerError extends Data.TaggedError("ScribeRunnerError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

export class ScribeRunner extends Context.Service<
  ScribeRunner,
  { readonly run: (call: ScribeCall) => Effect.Effect<ScribeResult, ScribeRunnerError> }
>()("t3/ledger/ScribeRunner") {}

const TIMEOUT = "180 seconds";

/**
 * Variables a Claude Code session sets for its children. The T3 server can inherit them when it
 * was started from one, and they would load that session's plugins and hooks into the scribe.
 */
const INHERITED_SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_PLUGIN_DIRS",
  "CLAUDE_PLUGIN_DATA",
  "CLAUDE_CODE_ENABLE_TODO_TOOLS",
];

export const scribeEnvironment = (base: NodeJS.ProcessEnv): NodeJS.ProcessEnv => {
  const env = { ...base };
  for (const name of INHERITED_SESSION_VARIABLES) delete env[name];
  return env;
};

/**
 * The CLI flags of a scribe call. No tools, MCP servers, slash commands, hooks or setting files
 * (so no plugins and no CLAUDE.md), and nothing saved. The Claude provider instance's launch
 * arguments and environment are deliberately not used: they load the working agent's setup.
 */
export const scribeArgs = (input: {
  readonly model: string;
  readonly systemPromptFile: string;
  readonly schemaJson: string;
  readonly managedMcpConfig: boolean;
}): ReadonlyArray<string> => [
  "-p",
  "--model",
  input.model,
  "--system-prompt-file",
  input.systemPromptFile,
  "--tools",
  "",
  // managed-mcp.json already isolates servers and makes Claude reject this flag.
  ...(input.managedMcpConfig ? [] : ["--strict-mcp-config"]),
  "--setting-sources",
  "",
  "--settings",
  '{"disableAllHooks":true}',
  "--disable-slash-commands",
  "--no-session-persistence",
  "--output-format",
  "json",
  "--json-schema",
  input.schemaJson,
];

const UnknownJson = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeOption(UnknownJson);
const decodeClaudeSettings = Schema.decodeOption(ClaudeSettings);
const encodeJson = Schema.encodeEffect(UnknownJson);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The structured reply and cost from `--output-format json` stdout: `structured_output`, or else
 * the first JSON object in the `result` text.
 */
export function readScribeOutput(stdout: string): ScribeResult | { readonly error: string } {
  const parsed = Option.getOrUndefined(decodeJson(stdout.trim()));
  const envelope = Array.isArray(parsed)
    ? parsed.findLast((message) => isRecord(message) && message.type === "result")
    : parsed;
  if (!isRecord(envelope)) return { error: "Claude CLI returned unexpected output." };
  const result = typeof envelope.result === "string" ? envelope.result : "";
  if (envelope.is_error === true)
    return { error: result.trim() || "Claude CLI reported an error." };
  const costUsd = typeof envelope.total_cost_usd === "number" ? envelope.total_cost_usd : 0;
  if (isRecord(envelope.structured_output)) return { output: envelope.structured_output, costUsd };
  const match = /\{[\s\S]*\}/.exec(result);
  const fallback = match === null ? undefined : Option.getOrUndefined(decodeJson(match[0]));
  return isRecord(fallback)
    ? { output: fallback, costUsd }
    : { error: "Claude returned no structured output." };
}

/** The binary and config home of the `claudeAgent` instance; nothing else of it. */
const claudeInstall = (settings: ServerSettings | undefined) => {
  const instances = settings?.providerInstances ?? {};
  const instance =
    instances[ProviderInstanceId.make("claudeAgent")] ??
    Object.values(instances).find((candidate) => candidate.driver === "claudeAgent");
  const config = decodeClaudeSettings(instance?.config ?? {});
  return {
    binaryPath: Option.match(config, {
      onNone: () => "claude",
      onSome: (claude) => claude.binaryPath || "claude",
    }),
    homePath: Option.match(config, { onNone: () => "", onSome: (claude) => claude.homePath }),
  };
};

const make = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettingsService.ServerSettingsService;

  const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (acc, chunk) => acc + chunk,
      ),
    );

  const runOnce = Effect.fn("ScribeRunner.runOnce")(function* (call: ScribeCall) {
    const install = claudeInstall(
      yield* settings.getSettings.pipe(Effect.orElseSucceed(() => undefined)),
    );
    const env = yield* makeClaudeEnvironment(
      { homePath: install.homePath },
      scribeEnvironment(process.env),
    );
    // An empty working directory: no project CLAUDE.md, no repository for Claude to notice.
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-ledger-" });
    const systemPromptFile = path.join(cwd, "scribe.md");
    yield* fs.writeFileString(systemPromptFile, call.systemPrompt);
    const spawnCommand = yield* resolveSpawnCommand(
      install.binaryPath,
      scribeArgs({
        model: call.model,
        systemPromptFile,
        schemaJson: yield* encodeJson(call.schema),
        managedMcpConfig: yield* hasClaudeManagedMcpConfig(),
      }),
      { env },
    );
    const child = yield* spawner.spawn(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env,
        cwd,
        shell: spawnCommand.shell,
        stdin: { stream: Stream.encodeText(Stream.make(call.prompt)) },
        forceKillAfter: "1 second",
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [collect(child.stdout), collect(child.stderr), child.exitCode],
      { concurrency: "unbounded" },
    );
    const read = readScribeOutput(stdout);
    if ("error" in read) {
      return yield* new ScribeRunnerError({
        detail:
          exitCode === 0 || stderr.trim().length === 0
            ? read.error
            : `${read.error} (exit ${exitCode}: ${stderr.trim().slice(0, 500)})`,
      });
    }
    return read;
  });

  const run: ScribeRunner["Service"]["run"] = (call) =>
    runOnce(call).pipe(
      Effect.scoped,
      Effect.provideService(Path.Path, path),
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.timeoutOption(TIMEOUT),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ScribeRunnerError({ detail: "Claude CLI timed out." })),
          onSome: Effect.succeed,
        }),
      ),
      Effect.mapError((error) =>
        error instanceof ScribeRunnerError
          ? error
          : new ScribeRunnerError({ detail: "Claude CLI could not run.", cause: error }),
      ),
    );

  return ScribeRunner.of({ run });
});

export const layer = Layer.effect(ScribeRunner, make);
