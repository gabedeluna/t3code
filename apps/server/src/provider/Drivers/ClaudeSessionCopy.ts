import { ClaudeSettings, type ProviderInstanceConfig } from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { resolveClaudeHomePath } from "./ClaudeHome.ts";

/**
 * A transcript written this recently may belong to a Claude Code session that
 * is still open, and a copy of it would miss what that session writes next.
 */
const CLAUDE_SESSION_QUIET_MS = 60_000;

const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Claude Code caps a project folder name at this length and adds a hash of the full path.
const MAX_PROJECT_SLUG_LENGTH = 200;

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const TranscriptLineJson = Schema.fromJsonString(Schema.Unknown);
const decodeTranscriptLine = Schema.decodeUnknownOption(TranscriptLineJson);
const encodeTranscriptLine = Schema.encodeSync(TranscriptLineJson);

export class ClaudeSessionNotFoundError extends Schema.TaggedError<ClaudeSessionNotFoundError>()(
  "ClaudeSessionNotFoundError",
  { sessionId: Schema.String, reason: Schema.Literals(["missing", "empty"]) },
) {
  override get message(): string {
    return this.reason === "empty"
      ? `Claude session ${this.sessionId} has no conversation to copy.`
      : `No Claude Code transcript named ${this.sessionId}.jsonl was found.`;
  }
}

export class ClaudeSessionActiveError extends Schema.TaggedError<ClaudeSessionActiveError>()(
  "ClaudeSessionActiveError",
  { sessionId: Schema.String, transcriptPath: Schema.String },
) {
  override get message(): string {
    return `Claude session ${this.sessionId} changed in the last ${CLAUDE_SESSION_QUIET_MS / 1000} s, so it may still be open. Close it in Claude Code, wait a minute, and try again.`;
  }
}

export class ClaudeSessionCopyError extends Schema.TaggedError<ClaudeSessionCopyError>()(
  "ClaudeSessionCopyError",
  { sessionId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not copy Claude session ${this.sessionId}.`;
  }
}

/** The folder Claude Code keeps a working directory's sessions in, under `<config>/projects`. */
export const claudeProjectSlug = (cwd: string): string => {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, "-");
  if (slug.length <= MAX_PROJECT_SLUG_LENGTH) return slug;
  let hash = 0;
  for (let index = 0; index < cwd.length; index++) {
    hash = ((hash << 5) - hash + cwd.charCodeAt(index)) | 0;
  }
  return `${slug.slice(0, MAX_PROJECT_SLUG_LENGTH)}-${Math.abs(hash).toString(36)}`;
};

/** The config home a Claude instance's sessions live in, resolved as its adapter resolves it. */
export const claudeInstanceConfigDir = Effect.fn("claudeInstanceConfigDir")(function* (
  instance: ProviderInstanceConfig | undefined,
) {
  const settings = Option.getOrElse(decodeClaudeSettings(instance?.config ?? {}), () => ({
    homePath: "",
  }));
  const environment = yield* mergeProviderInstanceEnvironment(
    instance?.environment,
    yield* HostProcess.Environment,
  );
  return yield* resolveClaudeHomePath(settings, environment);
});

/** What the copy learned of the conversation while it rewrote it. */
export interface ClaudeTranscriptSummary {
  readonly conversationLines: number;
  /** The newest message, which a rollback to the thread's start returns to. */
  readonly leafUuid?: string;
  readonly model?: string;
  /** The title the user gave the session in Claude Code, else the one it generated. */
  readonly customTitle?: string;
  readonly aiTitle?: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringField = (record: Record<string, unknown>, key: string) => {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
};

/**
 * One transcript line, under the copy's session id. Only the line's own
 * `sessionId` changes: ids it refers to, such as `forkedFrom`, and paths into
 * the source's tool-result folder still name the source, which stays.
 */
export const rewriteClaudeTranscriptLine = (
  line: string,
  ids: { readonly from: string; readonly to: string },
  summary: ClaudeTranscriptSummary,
): { readonly line: string; readonly summary: ClaudeTranscriptSummary } => {
  if (!line.includes(ids.from)) return { line, summary };
  const entry = Option.getOrUndefined(decodeTranscriptLine(line));
  if (!isRecord(entry) || entry.sessionId !== ids.from) return { line, summary };
  const rewritten = encodeTranscriptLine({ ...entry, sessionId: ids.to });
  const type = entry.type;
  if ((type === "user" || type === "assistant") && entry.isSidechain !== true) {
    const message = isRecord(entry.message) ? entry.message : {};
    const uuid = stringField(entry, "uuid");
    const model = type === "assistant" ? stringField(message, "model") : undefined;
    return {
      line: rewritten,
      summary: {
        ...summary,
        conversationLines: summary.conversationLines + 1,
        ...(uuid === undefined ? {} : { leafUuid: uuid }),
        // Claude Code writes "<synthetic>" for messages no model produced.
        ...(model === undefined || model.startsWith("<") ? {} : { model }),
      },
    };
  }
  const customTitle = type === "custom-title" ? stringField(entry, "customTitle") : undefined;
  const aiTitle = type === "ai-title" ? stringField(entry, "aiTitle") : undefined;
  return {
    line: rewritten,
    summary: {
      ...summary,
      ...(customTitle === undefined ? {} : { customTitle }),
      ...(aiTitle === undefined ? {} : { aiTitle }),
    },
  };
};

interface TranscriptCandidate {
  readonly path: string;
  readonly projectDir: string;
  readonly info: FileSystem.File.Info;
}

const mtimeMillis = (info: FileSystem.File.Info) =>
  Option.match(info.mtime, { onNone: () => 0, onSome: (mtime) => mtime.getTime() });

/** The newest `<config>/projects/<folder>/<sessionId>.jsonl` across the config homes. */
const findClaudeTranscript = Effect.fn("findClaudeTranscript")(function* (
  sessionId: string,
  configDirs: ReadonlyArray<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let newest: TranscriptCandidate | undefined;
  for (const configDir of new Set(configDirs.map((dir) => path.resolve(dir)))) {
    const projectsDir = path.join(configDir, "projects");
    const projects = yield* fileSystem
      .readDirectory(projectsDir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    for (const project of projects) {
      const projectDir = path.join(projectsDir, project);
      const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
      // Stray files beside the project folders fail with ENOTDIR.
      const info = Option.getOrUndefined(
        yield* fileSystem.stat(transcriptPath).pipe(Effect.option),
      );
      if (info === undefined || info.type !== "File") continue;
      if (newest === undefined || mtimeMillis(info) > mtimeMillis(newest.info)) {
        newest = { path: transcriptPath, projectDir, info };
      }
    }
  }
  return newest;
});

export interface ClaudeSessionCopy {
  readonly sessionId: string;
  readonly transcriptPath: string;
  readonly sourcePath: string;
  readonly summary: ClaudeTranscriptSummary;
}

/**
 * Copies a Claude Code session into the folder Claude Code looks in for `cwd`,
 * under a new session id, so resuming the copy leaves the source as it was.
 * The source is only read. The SDK's `forkSession` writes its copy beside the
 * source, so it cannot move a session to another working directory.
 */
export const copyClaudeSession = Effect.fn("copyClaudeSession")(function* (input: {
  readonly sessionId: string;
  /** Config homes to look for the source in, such as the host's and the target instance's. */
  readonly sourceConfigDirs: ReadonlyArray<string>;
  readonly targetConfigDir: string;
  /** The working directory the copy will run in. */
  readonly cwd: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const fail = (cause: unknown) =>
    new ClaudeSessionCopyError({ sessionId: input.sessionId, cause });
  if (!CLAUDE_SESSION_ID.test(input.sessionId)) {
    return yield* new ClaudeSessionNotFoundError({ sessionId: input.sessionId, reason: "missing" });
  }
  const source = yield* findClaudeTranscript(input.sessionId, input.sourceConfigDirs);
  if (source === undefined) {
    return yield* new ClaudeSessionNotFoundError({ sessionId: input.sessionId, reason: "missing" });
  }
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  if (now - mtimeMillis(source.info) < CLAUDE_SESSION_QUIET_MS) {
    return yield* new ClaudeSessionActiveError({
      sessionId: input.sessionId,
      transcriptPath: source.path,
    });
  }

  // Claude Code names the folder after the canonical path it runs in.
  const cwd = (yield* fileSystem
    .realPath(input.cwd)
    .pipe(Effect.orElseSucceed(() => path.resolve(input.cwd)))).normalize("NFC");
  const projectDir = path.join(input.targetConfigDir, "projects", claudeProjectSlug(cwd));
  const sessionId = yield* crypto.randomUUIDv4().pipe(Effect.mapError(fail));
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  const partialPath = `${transcriptPath}.partial`;
  yield* fileSystem.makeDirectory(projectDir, { recursive: true }).pipe(Effect.mapError(fail));

  let summary: ClaudeTranscriptSummary = { conversationLines: 0 };
  const ids = { from: input.sessionId, to: sessionId };
  // Claude Code stamps a transcript it moves to another working directory the same way.
  const relocated =
    path.resolve(source.projectDir) === path.resolve(projectDir)
      ? []
      : [encodeTranscriptLine({ type: "relocated", sessionId, relocatedCwd: cwd })];
  const written = Effect.gen(function* () {
    yield* fileSystem.stream(source.path).pipe(
      Stream.decodeText,
      Stream.splitLines,
      Stream.map((line) => {
        const next = rewriteClaudeTranscriptLine(line, ids, summary);
        summary = next.summary;
        return `${next.line}\n`;
      }),
      Stream.concat(Stream.fromIterable(relocated.map((line) => `${line}\n`))),
      Stream.encodeText,
      Stream.run(fileSystem.sink(partialPath)),
      Effect.mapError(fail),
    );
    if (summary.conversationLines === 0) {
      return yield* new ClaudeSessionNotFoundError({ sessionId: input.sessionId, reason: "empty" });
    }
    // A write during the copy means the session is open after all.
    const after = yield* fileSystem.stat(source.path).pipe(Effect.mapError(fail));
    if (after.size !== source.info.size || mtimeMillis(after) !== mtimeMillis(source.info)) {
      return yield* new ClaudeSessionActiveError({
        sessionId: input.sessionId,
        transcriptPath: source.path,
      });
    }
    yield* fileSystem.rename(partialPath, transcriptPath).pipe(Effect.mapError(fail));
  });
  yield* written.pipe(Effect.onError(() => fileSystem.remove(partialPath).pipe(Effect.ignore)));
  return {
    sessionId,
    transcriptPath,
    sourcePath: source.path,
    summary,
  } satisfies ClaudeSessionCopy;
});
