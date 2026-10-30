import type {
  LedgerLiveTask,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2PlanStep,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { IncomingSource } from "./ledgerDocument.ts";
import { clip, type LedgerTurn } from "./ledgerPrompts.ts";

// The replay lab's extraction limits, which the scribe prompts were tuned on.
const INCOMING_LIMIT = 4000;
const TOOL_LINES = 40;
const HEAD_LINES = 20;
const TAIL_LINES = 15;

/** The thread a cross-thread message came from. */
export interface TurnSender {
  readonly title: string;
  readonly director: boolean;
}

/** The Director runs on its own provider instance (`claude-director`); a title can say it too. */
export const isDirectorThread = (
  thread: Pick<OrchestrationV2AppThread, "title" | "providerInstanceId">,
) => /director/i.test(thread.providerInstanceId) || /director/i.test(thread.title);

const short = (value: string, limit = 120) => {
  const s = value.replace(/\s+/g, " ").trim();
  return s.length <= limit ? s : `${s.slice(0, limit - 1)}…`;
};

const encodeJson = Schema.encodeOption(Schema.fromJsonString(Schema.Unknown));
const json = (value: unknown) => Option.getOrElse(encodeJson(value), () => "");

const answerText = (value: unknown) =>
  typeof value === "string"
    ? value
    : Array.isArray(value) && value.every((v) => typeof v === "string")
      ? value.join(", ")
      : json(value);

/** The scribe reads what happened, not the ledger's reads or the agent's edits, already in it. */
const isLedgerTool = (name: string) =>
  /t3_ledger_(read|update)$/.test(name) || name === "ToolSearch";

/** One short line per tool call, enough to tell what Claude did; questions and answers in full. */
function toolLines(item: OrchestrationV2TurnItem): ReadonlyArray<string> {
  switch (item.type) {
    case "command_execution": {
      const failed = item.outputIndicatesFailure === true || (item.exitCode ?? 0) !== 0;
      return [`Command: ${short(item.title ?? item.input)}${failed ? " (failed)" : ""}`];
    }
    case "file_change":
      return [`Edited ${item.fileName}`];
    case "file_search":
      return [short(item.title ?? `Searched ${item.pattern ?? ""}`)];
    case "web_search":
      return [`Web search: ${short(item.title ?? (item.patterns ?? []).join("; "))}`];
    case "subagent":
      return [`Subagent: ${short(item.title ?? item.prompt)}`];
    case "dynamic_tool": {
      const name = item.toolName ?? "tool";
      if (isLedgerTool(name)) return [];
      const title = item.title?.trim();
      return [
        title
          ? short(title.startsWith(name) ? title : `${name}: ${title}`)
          : `${name} ${short(json(item.input), 100)}`,
      ];
    }
    case "user_input_request": {
      const asked = `Asked the user: ${item.questions.map((q) => short(q.question, 200)).join(" | ")}`;
      const answers = item.questionAnswer?.answers;
      if (answers === undefined) return [asked];
      const byId = new Map(item.questions.map((q) => [q.id, q.question]));
      const answered = Object.entries(answers)
        .map(([id, value]) => {
          const question = item.questionAnswer?.questionTextById?.[id] ?? byId.get(id);
          return `${question ? `${short(question, 80)}: ` : ""}${short(answerText(value), 200)}`;
        })
        .join("; ");
      return [asked, `User answered: ${answered}`];
    }
    case "todo_list":
      return [
        `To-do list: ${item.steps.map((s) => `[${s.status}] ${short(s.text, 80)}`).join("; ")}`,
      ];
    case "proposed_plan":
      return [`Proposed a plan: ${short(item.markdown, 200)}`];
    default:
      return [];
  }
}

const keepEnds = (lines: ReadonlyArray<string>) =>
  lines.length <= TOOL_LINES
    ? lines
    : [
        ...lines.slice(0, HEAD_LINES),
        `[... ${lines.length - HEAD_LINES - TAIL_LINES} more tool calls ...]`,
        ...lines.slice(-TAIL_LINES),
      ];

/** Who sent the turn's message, as a label the scribe reads and as what it may record from it. */
function attribution(
  message: OrchestrationV2ConversationMessage | undefined,
  sender: TurnSender | undefined,
): { readonly label: string | undefined; readonly source: IncomingSource } {
  if (message?.senderThreadId !== undefined) {
    return sender === undefined
      ? { label: "[Message from another thread]", source: "other-session" }
      : {
          label: `[Message from ${sender.title}]`,
          source: sender.director ? "director" : "other-session",
        };
  }
  if (message?.notification !== undefined) {
    return { label: `[Notification: ${message.notification.summary}]`, source: "other-session" };
  }
  if (message !== undefined && message.createdBy !== "user") {
    return {
      label: message.createdBy === "agent" ? "[Message from an agent]" : "[Message from T3]",
      source: "other-session",
    };
  }
  return { label: undefined, source: "user" };
}

export interface ReadTurnInput {
  readonly number: number;
  /** The message that started the run. */
  readonly message: OrchestrationV2ConversationMessage | undefined;
  /** The run's turn items, in any order. */
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly sender?: TurnSender | undefined;
}

/**
 * One finished run as the scribe reads it: the incoming message (with what was added while it
 * ran), every reply Claude wrote, and a line per tool call. Undefined for T3's own idle
 * compaction, where nothing happened worth recording.
 */
export function readTurn(
  input: ReadTurnInput,
): { readonly turn: LedgerTurn; readonly source: IncomingSource } | undefined {
  const { message } = input;
  if (message?.idleCompaction !== undefined) return undefined;
  const items = input.items.toSorted((a, b) => a.ordinal - b.ordinal);
  const added = items.flatMap((item) =>
    item.type === "user_message" && item.messageId !== message?.id && item.text.trim()
      ? [`[Added during the turn]\n${item.text.trim()}`]
      : [],
  );
  const { label, source } = attribution(message, input.sender);
  const text = [message?.text.trim() ?? "", ...added]
    .filter((part) => part.length > 0)
    .join("\n\n");
  return {
    turn: {
      number: input.number,
      incoming: clip(label === undefined ? text : `${label}\n${text}`, INCOMING_LIMIT),
      reply: items
        .flatMap((item) =>
          item.type === "assistant_message" && item.text.trim() ? [item.text.trim()] : [],
        )
        .join("\n\n"),
      tools: keepEnds(items.flatMap(toolLines)),
    },
    source,
  };
}

/** The working agent's task list as the ledger mirrors it. */
export const liveTasksFrom = (steps: ReadonlyArray<OrchestrationV2PlanStep>): LedgerLiveTask[] =>
  steps.map((step) => ({
    id: step.id,
    text: step.text,
    status: step.status === "running" ? "in_progress" : step.status,
  }));
