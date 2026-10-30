import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import {
  claudeInstanceConfigDir,
  claudeProjectSlug,
  copyClaudeSession,
  rewriteClaudeTranscriptLine,
} from "./ClaudeSessionCopy.ts";

const SOURCE_ID = "0b6a1f9e-2c4d-4e8f-9a1b-3c5d7e9f1a2b";
const TranscriptLineJson = Schema.fromJsonString(Schema.Unknown);
const encodeLine = Schema.encodeSync(TranscriptLineJson);
const decodeLine = Schema.decodeUnknownSync(TranscriptLineJson);

const sourceLines = [
  { type: "custom-title", customTitle: "Fix the parser", sessionId: SOURCE_ID },
  {
    type: "user",
    uuid: "u-1",
    parentUuid: null,
    cwd: "/old/folder",
    sessionId: SOURCE_ID,
    message: { role: "user", content: "Remember the word PELICAN." },
  },
  {
    type: "assistant",
    uuid: "a-1",
    parentUuid: "u-1",
    sessionId: SOURCE_ID,
    forkedFrom: { sessionId: "9f8e7d6c-5b4a-4321-8fed-cba987654321", messageUuid: "x" },
    message: { role: "assistant", model: "claude-haiku-5-5-20261001", content: "ok" },
  },
  {
    type: "user",
    uuid: "u-2",
    parentUuid: "a-1",
    sessionId: SOURCE_ID,
    // A tool result that quotes the session keeps quoting the source.
    toolUseResult: {
      sessionId: SOURCE_ID,
      path: `/cfg/projects/-old/${SOURCE_ID}/tool-results/1.txt`,
    },
    message: { role: "user", content: "next" },
  },
  {
    type: "assistant",
    uuid: "side-1",
    isSidechain: true,
    sessionId: SOURCE_ID,
    message: { role: "assistant", model: "claude-opus-5-5", content: "side" },
  },
  { type: "file-history-snapshot", messageId: "u-1", snapshot: {} },
].map((line) => encodeLine(line));

const layer = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);
// The test clock reads this; transcripts are dated back from it.
const NOW_MS = 1_767_225_600_000;

/** A config home holding the source transcript, last written `ageMs` ago. */
const sourceHome = Effect.fn("test.sourceHome")(function* (input: {
  readonly lines: ReadonlyArray<string>;
  readonly ageMs: number;
  readonly folder?: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-copy-" });
  const projectDir = path.join(configDir, "projects", input.folder ?? "-old-folder");
  yield* fileSystem.makeDirectory(path.join(projectDir, SOURCE_ID, "tool-results"), {
    recursive: true,
  });
  const sourcePath = path.join(projectDir, `${SOURCE_ID}.jsonl`);
  yield* fileSystem.writeFileString(sourcePath, `${input.lines.join("\n")}\n`);
  yield* TestClock.setTime(NOW_MS);
  // Numbers are seconds to utimes.
  const writtenAtMs = NOW_MS - input.ageMs;
  yield* fileSystem.utimes(sourcePath, writtenAtMs / 1000, writtenAtMs / 1000);
  const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-copy-cwd-" });
  return { configDir, projectDir, sourcePath, cwd, writtenAtMs };
});

describe("claudeProjectSlug", () => {
  it("turns every character but letters and digits into a dash, as Claude Code does", () => {
    assert.equal(claudeProjectSlug("E:\\projects\\t3code-work"), "E--projects-t3code-work");
    assert.equal(claudeProjectSlug("C:\\Users\\gtroc"), "C--Users-gtroc");
    assert.equal(claudeProjectSlug("/home/me/My Project.v2"), "-home-me-My-Project-v2");
  });

  it("caps a long folder name and adds the hash Claude Code adds", () => {
    const long = `/home/me/${"nested-folder/".repeat(16)}app`;
    // The value Claude Agent SDK 0.3.276 computes for this path.
    assert.equal(
      claudeProjectSlug(long),
      "-home-me-nested-folder-nested-folder-nested-folder-nested-folder-nested-folder-nested-folder-nested-folder-nested-folder-nested-folder-nested-folder-nested-folder-nested-folder-nested-folder-nested-fo-kb4ra3",
    );
  });
});

describe("rewriteClaudeTranscriptLine", () => {
  it("moves only the line's own session id and leaves lines without it as they were", () => {
    const ids = { from: SOURCE_ID, to: "11111111-2222-4333-8444-555555555555" };
    const untouched = sourceLines[5] ?? "";
    assert.strictEqual(
      rewriteClaudeTranscriptLine(untouched, ids, { conversationLines: 0 }).line,
      untouched,
    );
    const quoted = decodeLine(
      rewriteClaudeTranscriptLine(sourceLines[3] ?? "", ids, { conversationLines: 0 }).line,
    ) as { sessionId: string; toolUseResult: { sessionId: string } };
    assert.equal(quoted.sessionId, ids.to);
    assert.equal(quoted.toolUseResult.sessionId, SOURCE_ID);
    // Malformed lines are copied as they are.
    assert.equal(
      rewriteClaudeTranscriptLine(`{"sessionId":"${SOURCE_ID}"`, ids, { conversationLines: 0 })
        .line,
      `{"sessionId":"${SOURCE_ID}"`,
    );
  });
});

describe("copyClaudeSession", () => {
  it.effect(
    "copies a quiet session into the new folder under a new id and leaves the source alone",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* sourceHome({ lines: sourceLines, ageMs: 5 * 60_000 });
          const before = yield* fileSystem.readFile(home.sourcePath);

          const copy = yield* copyClaudeSession({
            sessionId: SOURCE_ID,
            sourceConfigDirs: [home.configDir],
            targetConfigDir: home.configDir,
            cwd: home.cwd,
          });

          const cwd = (yield* fileSystem.realPath(home.cwd)).normalize("NFC");
          assert.equal(
            copy.transcriptPath,
            path.join(
              home.configDir,
              "projects",
              claudeProjectSlug(cwd),
              `${copy.sessionId}.jsonl`,
            ),
          );
          assert.notEqual(copy.sessionId, SOURCE_ID);
          assert.equal(copy.sourcePath, home.sourcePath);
          assert.deepEqual(copy.summary, {
            conversationLines: 3,
            leafUuid: "u-2",
            model: "claude-haiku-5-5-20261001",
            customTitle: "Fix the parser",
          });

          const copied = (yield* fileSystem.readFileString(copy.transcriptPath))
            .split("\n")
            .filter((line) => line.length > 0);
          assert.equal(copied.length, sourceLines.length + 1);
          copied.slice(0, sourceLines.length).forEach((line, index) => {
            const original = decodeLine(sourceLines[index]) as Record<string, unknown>;
            const expected =
              original.sessionId === SOURCE_ID
                ? { ...original, sessionId: copy.sessionId }
                : original;
            assert.deepEqual(decodeLine(line), expected);
          });
          assert.deepEqual(decodeLine(copied.at(-1)), {
            type: "relocated",
            sessionId: copy.sessionId,
            relocatedCwd: cwd,
          });

          // The source, its time and its sidecar folder are as they were.
          assert.deepEqual(yield* fileSystem.readFile(home.sourcePath), before);
          const info = yield* fileSystem.stat(home.sourcePath);
          assert.equal(Option.getOrUndefined(info.mtime)?.getTime(), home.writtenAtMs);
          assert.deepEqual(yield* fileSystem.readDirectory(path.join(home.projectDir, SOURCE_ID)), [
            "tool-results",
          ]);
          assert.isFalse(yield* fileSystem.exists(`${copy.transcriptPath}.partial`));
        }),
      ).pipe(Effect.provide(layer)),
  );

  it.effect("adds no relocation stamp when the copy stays in the source's folder", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const probe = yield* sourceHome({ lines: [], ageMs: 5 * 60_000 });
        const cwd = (yield* fileSystem.realPath(probe.cwd)).normalize("NFC");
        const home = yield* sourceHome({
          lines: sourceLines,
          ageMs: 5 * 60_000,
          folder: claudeProjectSlug(cwd),
        });
        const copy = yield* copyClaudeSession({
          sessionId: SOURCE_ID,
          sourceConfigDirs: [home.configDir],
          targetConfigDir: home.configDir,
          cwd: probe.cwd,
        });
        const copied = (yield* fileSystem.readFileString(copy.transcriptPath))
          .trimEnd()
          .split("\n");
        assert.equal(copied.length, sourceLines.length);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("refuses a session written in the last minute and writes nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* sourceHome({ lines: sourceLines, ageMs: 5_000 });
        const error = yield* Effect.flip(
          copyClaudeSession({
            sessionId: SOURCE_ID,
            sourceConfigDirs: [home.configDir],
            targetConfigDir: home.configDir,
            cwd: home.cwd,
          }),
        );
        assert.equal(error._tag, "ClaudeSessionActiveError");
        assert.include(error.message, "Close it in Claude Code");
        assert.deepEqual(yield* fileSystem.readDirectory(`${home.configDir}/projects`), [
          "-old-folder",
        ]);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("refuses an unknown id, a non-UUID id and a transcript with no conversation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const empty = yield* sourceHome({
          lines: [encodeLine({ type: "last-prompt", lastPrompt: "hi", sessionId: SOURCE_ID })],
          ageMs: 5 * 60_000,
        });
        const copyFrom = (sessionId: string) =>
          Effect.flip(
            copyClaudeSession({
              sessionId,
              sourceConfigDirs: [empty.configDir],
              targetConfigDir: empty.configDir,
              cwd: empty.cwd,
            }),
          );

        const unknown = yield* copyFrom("22222222-3333-4444-8555-666666666666");
        assert.deepInclude(unknown, { _tag: "ClaudeSessionNotFoundError", reason: "missing" });
        const traversal = yield* copyFrom("../../secrets");
        assert.deepInclude(traversal, { _tag: "ClaudeSessionNotFoundError", reason: "missing" });
        const nothing = yield* copyFrom(SOURCE_ID);
        assert.deepInclude(nothing, { _tag: "ClaudeSessionNotFoundError", reason: "empty" });

        const cwd = (yield* fileSystem.realPath(empty.cwd)).normalize("NFC");
        const target = path.join(empty.configDir, "projects", claudeProjectSlug(cwd));
        assert.deepEqual(yield* fileSystem.readDirectory(target), []);
      }),
    ).pipe(Effect.provide(layer)),
  );

  it.effect("finds the source in any of the config homes it is given", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const home = yield* sourceHome({ lines: sourceLines, ageMs: 5 * 60_000 });
        const instanceHome = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-instance-",
        });
        const copy = yield* copyClaudeSession({
          sessionId: SOURCE_ID,
          sourceConfigDirs: [instanceHome, home.configDir],
          targetConfigDir: instanceHome,
          cwd: home.cwd,
        });
        assert.isTrue(copy.transcriptPath.startsWith(instanceHome));
        assert.isTrue(yield* fileSystem.exists(copy.transcriptPath));
      }),
    ).pipe(Effect.provide(layer)),
  );
});

describe("claudeInstanceConfigDir", () => {
  it.effect("resolves an instance's home as its adapter does", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const claude = ProviderDriverKind.make("claudeAgent");
      const host = yield* claudeInstanceConfigDir(undefined);
      assert.equal(host, path.resolve("/host/claude"));
      const fromEnvironment = yield* claudeInstanceConfigDir({
        driver: claude,
        environment: [{ name: "CLAUDE_CONFIG_DIR", value: "/director/claude", sensitive: false }],
      });
      assert.equal(fromEnvironment, path.resolve("/director/claude"));
      const fromHomePath = yield* claudeInstanceConfigDir({
        driver: claude,
        config: { homePath: "/work/claude" },
      });
      assert.equal(fromHomePath, path.resolve("/work/claude"));
    }).pipe(
      Effect.provideService(HostProcess.Environment, { CLAUDE_CONFIG_DIR: "/host/claude" }),
      Effect.provide(layer),
    ),
  );
});
