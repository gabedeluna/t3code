import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

/**
 * A turn's agent-facing context as a text block ahead of the prompt, each entry in a tag named by
 * its key. Only the SDK message carries it: the user's message in T3's timeline stays as typed,
 * and the prompt stays the last text block, where Claude looks for a `/skill`.
 */
export function withClaudeTurnContext(
  message: SDKUserMessage,
  appContext: ProviderAdapter.ProviderAdapterV2TurnInput["appContext"],
): SDKUserMessage {
  const entries = (appContext ?? []).filter((entry) => entry.text.trim().length > 0);
  if (entries.length === 0) return message;
  const text = entries
    .map((entry) => {
      const tag = entry.key.replace(/[^\w.-]/g, "_");
      return `<${tag}>\n${entry.text.trim()}\n</${tag}>`;
    })
    .join("\n\n");
  const { content } = message.message;
  return {
    ...message,
    message: {
      ...message.message,
      content: [
        { type: "text", text },
        ...(typeof content !== "string"
          ? content
          : content.length > 0
            ? [{ type: "text" as const, text: content }]
            : []),
      ],
    },
  };
}
