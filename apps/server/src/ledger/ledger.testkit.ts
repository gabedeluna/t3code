import {
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export const at = DateTime.makeUnsafe("2026-10-29T00:00:00.000Z");
export const ledgerThreadId = ThreadId.make("thread:ledger");

export const runIdOf = (n: number) => RunId.make(`run:ledger-${n}`);

export const run = (n: number, status: OrchestrationV2Run["status"] = "completed") =>
  ({
    id: runIdOf(n),
    threadId: ledgerThreadId,
    ordinal: n,
    status,
    userMessageId: MessageId.make(`message:ledger-${n}`),
  }) as OrchestrationV2Run;

export const message = (
  n: number,
  text: string,
  extra: Partial<OrchestrationV2ConversationMessage> = {},
): OrchestrationV2ConversationMessage => ({
  id: MessageId.make(`message:ledger-${n}`),
  threadId: ledgerThreadId,
  runId: runIdOf(n),
  nodeId: null,
  role: "user",
  text,
  attachments: [],
  streaming: false,
  createdAt: at,
  updatedAt: at,
  createdBy: "user",
  creationSource: "web",
  ...extra,
});

/** A turn item of run `n` with every base field filled in. */
export const item = (
  n: number,
  ordinal: number,
  fields: { readonly type: OrchestrationV2TurnItem["type"] } & Record<string, unknown>,
) =>
  ({
    id: TurnItemId.make(`item:ledger-${n}-${ordinal}`),
    threadId: ledgerThreadId,
    runId: runIdOf(n),
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: at,
    ...fields,
  }) as unknown as OrchestrationV2TurnItem;

export const thread = (extra: Partial<OrchestrationV2AppThread> = {}) =>
  ({
    id: ledgerThreadId,
    title: "Stone textures",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    lineage: { rootThreadId: ledgerThreadId, parentThreadId: null, relationshipToParent: null },
    deletedAt: null,
    archivedAt: null,
    ...extra,
  }) as OrchestrationV2AppThread;
