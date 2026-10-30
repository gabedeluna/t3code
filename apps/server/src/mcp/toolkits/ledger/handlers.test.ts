import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadProjection,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { emptyLedger } from "../../../ledger/ledgerDocument.ts";
import * as LedgerStore from "../../../ledger/LedgerStore.ts";
import * as LedgerWorkers from "../../../ledger/LedgerWorkers.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as LedgerHandlers from "./handlers.ts";
import { LedgerToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:ledger");
const caller = ThreadId.make("thread:caller");
const other = ThreadId.make("thread:other");

const layerFor = (read: Array<ThreadId>) =>
  McpToolAccess.HandlersLayer.layer(LedgerHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "provider:ledger",
          thread: {
            threadId: caller,
            providerSessionId: "provider:ledger",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          getProjectThreadRecords: (input) =>
            Effect.succeed({
              thread: { id: input.threadId, title: "Telify Director" },
            } as unknown as OrchestrationV2ThreadProjection),
        }),
        Layer.mock(LedgerStore.LedgerStore)({
          get: (threadId) =>
            Effect.sync(() => {
              read.push(threadId);
              const doc = emptyLedger(threadId, "2026-10-29T00:00:00.000Z");
              return threadId === other ? { ...doc, enabled: true, turns: 4 } : doc;
            }),
        }),
        Layer.mock(LedgerWorkers.LedgerWorkers)({
          rollup: (threadId) =>
            Effect.sync(() => {
              read.push(threadId);
              return {
                threadId,
                workers:
                  threadId === caller
                    ? [
                        {
                          threadId: other,
                          title: "Hit reactions",
                          state: "working" as const,
                          group: "working" as const,
                          ledgerEnabled: false,
                          needs: [],
                          needCount: 0,
                          topics: [],
                        },
                      ]
                    : [],
              };
            }),
        }),
      ),
    ),
  );

const call = (
  params: { readonly threadId?: ThreadId },
  tool: "t3_ledger_read" | "t3_ledger_workers" = "t3_ledger_read",
) =>
  Effect.flatMap(LedgerToolkit, (toolkit) =>
    toolkit.handle(tool, params).pipe(Stream.unwrap, Stream.runCollect),
  ).pipe(Effect.map((results) => results.at(-1)?.result));

it.effect("t3_ledger_read reads the caller's own thread by default, as text", () => {
  const read: Array<ThreadId> = [];
  return Effect.gen(function* () {
    expect(yield* call({})).toEqual({ ledger: "Ledger is off for this thread." });
    expect(yield* call({ threadId: other })).toEqual({
      ledger: "Ledger after 4 turns.\nNo topics yet.",
    });
    expect(read).toEqual([caller, other]);
  }).pipe(Effect.provide(layerFor(read)));
});

it.effect("t3_ledger_workers rolls up the caller's workers by default, as text", () => {
  const read: Array<ThreadId> = [];
  return Effect.gen(function* () {
    expect(yield* call({}, "t3_ledger_workers")).toEqual({
      workers: [
        "Workers of Telify Director: 1, from their ledgers.",
        "Working (1):",
        "- Hit reactions [working] thread:other",
        "  ledger off",
      ].join("\n"),
    });
    expect(yield* call({ threadId: other }, "t3_ledger_workers")).toEqual({
      workers:
        "Telify Director has launched no workers (threads it started with t3_thread_launch).",
    });
    expect(read).toEqual([caller, other]);
  }).pipe(Effect.provide(layerFor(read)));
});
