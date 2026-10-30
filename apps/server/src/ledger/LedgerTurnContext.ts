import type { ThreadId } from "@t3tools/contracts";
import type { ProviderAdapterV2TurnMessage } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ledgerNote, sameShown, shownOf } from "./ledgerDelta.ts";
import * as LedgerStore from "./LedgerStore.ts";

/** The key the note travels under in a turn's agent-facing context. */
const LEDGER_CONTEXT_KEY = "t3_ledger";

export interface TurnContextEntry {
  readonly key: string;
  readonly text: string;
}

type TurnMessage = Pick<
  ProviderAdapterV2TurnMessage,
  "text" | "attachments" | "createdBy" | "creationSource"
>;

export interface LedgerTurnContextShape {
  readonly forTurn: (
    threadId: ThreadId,
    message: TurnMessage,
  ) => Effect.Effect<ReadonlyArray<TurnContextEntry>>;
}

/**
 * Context for the start of a working agent's turn: what changed in its thread's ledger since
 * its last turn. A reference with an empty default, so the run executor needs no ledger to run.
 */
export class LedgerTurnContext extends Context.Reference<LedgerTurnContextShape>(
  "t3/ledger/LedgerTurnContext",
  { defaultValue: () => ({ forTurn: () => Effect.succeed([]) }) },
) {}

/**
 * A turn that sends the agent no message of the user's: a provider continuation (Claude's own
 * wake-ups) or a compaction. A note given to one would be marked shown and never read.
 */
const carriesNoPrompt = (message: TurnMessage) =>
  (message.createdBy === "agent" && message.creationSource === "provider") ||
  (message.attachments.length === 0 && message.text.trim().toLowerCase() === "/compact");

export const layer = Layer.effect(
  LedgerTurnContext,
  Effect.gen(function* () {
    const store = yield* LedgerStore.LedgerStore;
    const forTurn: LedgerTurnContextShape["forTurn"] = Effect.fn("LedgerTurnContext.forTurn")(
      function* (threadId, message) {
        if (carriesNoPrompt(message)) return [];
        const doc = yield* store.get(threadId);
        if (!doc.enabled) return [];
        const before = yield* store.shown(threadId);
        const note = ledgerNote(doc, Option.getOrUndefined(before));
        const now = shownOf(doc);
        if (Option.isNone(before) || !sameShown(before.value, now)) {
          yield* store.setShown(threadId, now);
        }
        return note === undefined ? [] : [{ key: LEDGER_CONTEXT_KEY, text: note }];
      },
      (effect, threadId) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("reading a thread ledger's turn note failed", {
              threadId,
              cause,
            }).pipe(Effect.as([])),
          ),
        ),
    );
    return { forTurn };
  }),
);
