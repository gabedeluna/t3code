import { MessageId, PlanId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { item, message } from "./ledger.testkit.ts";
import { liveTasksFrom, readTurn } from "./ledgerTurn.ts";

describe("readTurn", () => {
  it("reads the message, every reply in order, and a line per tool call", () => {
    const read = readTurn({
      number: 3,
      message: message(1, "Make the stone 64 px."),
      items: [
        item(1, 5, {
          type: "assistant_message",
          messageId: MessageId.make("a2"),
          text: "Done.",
          streaming: false,
        }),
        item(1, 1, {
          type: "assistant_message",
          messageId: MessageId.make("a1"),
          text: "On it.",
          streaming: false,
        }),
        item(1, 2, { type: "command_execution", input: "pnpm test", exitCode: 1 }),
        item(1, 3, { type: "file_change", fileName: "src/stone.ts" }),
        item(1, 4, { type: "dynamic_tool", toolName: "mcp__t3-code__t3_ledger_read", input: {} }),
        item(1, 6, { type: "reasoning", text: "thinking", streaming: false }),
        item(1, 7, {
          type: "dynamic_tool",
          toolName: "mcp__t3-code__t3_ledger_update",
          input: { closes: [{ item: "q1", state: "answered", note: "64 px" }] },
        }),
      ],
    });
    assert.deepStrictEqual(read, {
      turn: {
        number: 3,
        incoming: "Make the stone 64 px.",
        reply: "On it.\n\nDone.",
        tools: ["Command: pnpm test (failed)", "Edited src/stone.ts"],
      },
      source: "user",
    });
  });

  it("includes the questions Claude asked and the user's answers", () => {
    const read = readTurn({
      number: 1,
      message: message(1, "Pick a size"),
      items: [
        item(1, 1, {
          type: "user_input_request",
          requestId: RuntimeRequestId.make("request-1"),
          questions: [{ id: "size", header: "Size", question: "Which size?", options: [] }],
          questionAnswer: {
            requestId: "request-1",
            answers: { size: "64 px" },
            attachmentsByQuestionId: {},
          },
        }),
        item(1, 2, {
          type: "todo_list",
          planId: PlanId.make("plan-1"),
          steps: [
            { id: "1", text: "Resize textures", status: "completed" },
            { id: "2", text: "Run the game", status: "running" },
          ],
        }),
      ],
    });
    assert.deepStrictEqual(read?.turn.tools, [
      "Asked the user: Which size?",
      "User answered: Which size?: 64 px",
      "To-do list: [completed] Resize textures; [running] Run the game",
    ]);
  });

  it("labels messages from other threads and tells the Director apart", () => {
    const sent = message(1, "Status?", {
      createdBy: "agent",
      creationSource: "mcp",
      senderThreadId: ThreadId.make("thread:other"),
    });
    const fromDirector = readTurn({
      number: 1,
      message: sent,
      items: [],
      sender: { title: "Director", director: true },
    });
    const fromWorker = readTurn({
      number: 1,
      message: sent,
      items: [],
      sender: { title: "Worker 2", director: false },
    });
    assert.strictEqual(fromDirector?.source, "director");
    assert.strictEqual(fromDirector?.turn.incoming, "[Message from Director]\nStatus?");
    assert.strictEqual(fromWorker?.source, "other-session");
    assert.strictEqual(fromWorker?.turn.incoming, "[Message from Worker 2]\nStatus?");
    const notified = readTurn({
      number: 1,
      message: message(1, "Task finished.", {
        createdBy: "agent",
        creationSource: "server",
        notification: {
          source: { kind: "system" },
          outcome: "completed",
          summary: "Delegated task finished",
        },
      }),
      items: [],
    });
    assert.strictEqual(notified?.source, "other-session");
  });

  it("adds messages sent while the run was working", () => {
    const read = readTurn({
      number: 1,
      message: message(1, "Fix the build"),
      items: [
        item(1, 1, {
          type: "user_message",
          messageId: MessageId.make("message:ledger-1"),
          text: "Fix the build",
          createdBy: "user",
          creationSource: "web",
          inputIntent: "turn_start",
          attachments: [],
        }),
        item(1, 2, {
          type: "user_message",
          messageId: MessageId.make("message:steer"),
          text: "and skip the flaky test",
          createdBy: "user",
          creationSource: "web",
          inputIntent: "steer",
          attachments: [],
        }),
      ],
    });
    assert.strictEqual(
      read?.turn.incoming,
      "Fix the build\n\n[Added during the turn]\nand skip the flaky test",
    );
  });

  it("keeps the first and last tool calls of a long turn", () => {
    const items = Array.from({ length: 50 }, (_, i) =>
      item(1, i + 1, { type: "file_change", fileName: `f${i + 1}.ts` }),
    );
    const tools = readTurn({ number: 1, message: message(1, "go"), items })!.turn.tools;
    assert.strictEqual(tools.length, 36);
    assert.strictEqual(tools[19], "Edited f20.ts");
    assert.strictEqual(tools[20], "[... 15 more tool calls ...]");
    assert.strictEqual(tools[35], "Edited f50.ts");
  });

  it("skips T3's own idle compaction", () => {
    assert.isUndefined(
      readTurn({
        number: 1,
        message: message(1, "/compact", { idleCompaction: "onReturn" }),
        items: [],
      }),
    );
  });
});

describe("liveTasksFrom", () => {
  it("maps a running step to in_progress", () => {
    assert.deepStrictEqual(
      liveTasksFrom([
        { id: "1", text: "Build", status: "completed" },
        { id: "2", text: "Test", status: "running" },
        { id: "3", text: "Ship", status: "pending" },
      ]).map((t) => t.status),
      ["completed", "in_progress", "pending"],
    );
  });
});
