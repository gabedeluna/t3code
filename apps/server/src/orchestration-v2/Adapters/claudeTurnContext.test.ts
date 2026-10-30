import { describe, expect, it } from "@effect/vitest";

import { makeClaudeUserMessage } from "./ClaudeAdapterV2.ts";
import { withClaudeTurnContext } from "./claudeTurnContext.ts";

describe("withClaudeTurnContext", () => {
  it("leaves a message without context as it is", () => {
    const message = makeClaudeUserMessage({ text: "Hi" });
    expect(withClaudeTurnContext(message, undefined)).toBe(message);
    expect(withClaudeTurnContext(message, [{ key: "t3_ledger", text: "  " }])).toBe(message);
  });

  it("puts the context in its own block ahead of the prompt", () => {
    const message = makeClaudeUserMessage({ text: "/review the diff", uuid: "a-b-c-d-e" });
    const withContext = withClaudeTurnContext(message, [
      { key: "t3_ledger", text: "Ledger changes since your last turn:\n- done t1" },
      { key: "mcp app:1", text: "Cart has 2 items" },
    ]);
    expect(withContext.uuid).toBe("a-b-c-d-e");
    expect(withContext.message.content).toEqual([
      {
        type: "text",
        text: "<t3_ledger>\nLedger changes since your last turn:\n- done t1\n</t3_ledger>\n\n<mcp_app_1>\nCart has 2 items\n</mcp_app_1>",
      },
      { type: "text", text: "/review the diff" },
    ]);
  });

  it("keeps image and text blocks after the context", () => {
    const message = {
      ...makeClaudeUserMessage({ text: "" }),
      message: {
        role: "user" as const,
        content: [
          {
            type: "image" as const,
            source: { type: "base64" as const, media_type: "image/png" as const, data: "AA==" },
          },
          { type: "text" as const, text: "What is this?" },
        ],
      },
    };
    const content = withClaudeTurnContext(message, [{ key: "t3_ledger", text: "note" }]).message
      .content as ReadonlyArray<{ readonly type: string }>;
    expect(content.map((block) => block.type)).toEqual(["text", "image", "text"]);
    expect(
      withClaudeTurnContext(makeClaudeUserMessage({ text: "" }), [{ key: "k", text: "note" }])
        .message.content,
    ).toEqual([{ type: "text", text: "<k>\nnote\n</k>" }]);
  });
});
