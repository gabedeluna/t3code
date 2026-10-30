import { assert, describe, it } from "@effect/vitest";

import { readScribeOutput, scribeArgs, scribeEnvironment } from "./ScribeRunner.ts";

describe("scribeArgs", () => {
  it("turns off tools, MCP, setting files, hooks, slash commands and session saving", () => {
    const args = scribeArgs({
      model: "haiku",
      systemPromptFile: "/tmp/scribe.md",
      schemaJson: "{}",
      managedMcpConfig: false,
    });
    const flag = (name: string) => args[args.indexOf(name) + 1];
    assert.strictEqual(args[0], "-p");
    assert.strictEqual(flag("--model"), "haiku");
    assert.strictEqual(flag("--system-prompt-file"), "/tmp/scribe.md");
    assert.strictEqual(flag("--tools"), "");
    assert.strictEqual(flag("--setting-sources"), "");
    assert.strictEqual(flag("--settings"), '{"disableAllHooks":true}');
    assert.strictEqual(flag("--output-format"), "json");
    assert.strictEqual(flag("--json-schema"), "{}");
    for (const name of [
      "--strict-mcp-config",
      "--no-session-persistence",
      "--disable-slash-commands",
    ]) {
      assert.include(args, name);
    }
    assert.notInclude(args, "--append-system-prompt-file");
  });

  it("leaves out --strict-mcp-config under a managed MCP config, which rejects it", () => {
    assert.notInclude(
      scribeArgs({
        model: "haiku",
        systemPromptFile: "f",
        schemaJson: "{}",
        managedMcpConfig: true,
      }),
      "--strict-mcp-config",
    );
  });
});

describe("scribeEnvironment", () => {
  it("drops what a parent Claude Code session would pass on, and keeps the rest", () => {
    const env = scribeEnvironment({
      PATH: "/bin",
      CLAUDE_CODE_PLUGIN_DIRS: "/mods/board",
      CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
      CLAUDECODE: "1",
      ANTHROPIC_API_KEY: "key",
    });
    assert.deepStrictEqual(env, { PATH: "/bin", ANTHROPIC_API_KEY: "key" });
  });
});

describe("readScribeOutput", () => {
  it("reads structured_output and the cost", () => {
    assert.deepStrictEqual(
      readScribeOutput(
        '{"type":"result","result":"","structured_output":{"closes":[]},"total_cost_usd":0.002}',
      ),
      { output: { closes: [] }, costUsd: 0.002 },
    );
  });

  it("falls back to the first JSON object in the result text", () => {
    assert.deepStrictEqual(
      readScribeOutput('{"type":"result","result":"Here: {\\"adds\\": []} done"}'),
      { output: { adds: [] }, costUsd: 0 },
    );
  });

  it("finds the result message in verbose output", () => {
    assert.deepStrictEqual(
      readScribeOutput(
        '[{"type":"system"},{"type":"result","structured_output":{"checks":[]},"total_cost_usd":0.01}]',
      ),
      { output: { checks: [] }, costUsd: 0.01 },
    );
  });

  it("reports CLI errors and unreadable output", () => {
    assert.deepStrictEqual(
      readScribeOutput('{"type":"result","is_error":true,"result":"Not logged in"}'),
      {
        error: "Not logged in",
      },
    );
    assert.property(readScribeOutput("not json"), "error");
    assert.property(readScribeOutput('{"type":"result","result":"no object here"}'), "error");
  });
});
