import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, LedgerDocument, ThreadId } from "@t3tools/contracts";
import {
  ArrowUpRightIcon,
  CircleIcon,
  MessageCircleQuestionIcon,
  NotebookTextIcon,
} from "lucide-react";

import { cn } from "../../lib/utils";
import { useRightPanelStore } from "../../rightPanelStore";
import { useThreadLedger } from "../../state/ledger";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { ThreadDetailsSection } from "../chat/ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "../chat/threadDetailsPanelStyles";
import { Switch } from "../ui/switch";
import {
  cardTopics,
  cardTopicsOverflowLabel,
  needsYouCounts,
  TOPIC_STATUS_LABELS,
} from "./ledger.logic";
import { TopicStatusIcon, topicStatusToneClass } from "./ledgerPresentation";
import { useLedgerSwitch } from "./useLedgerSwitch";

const HEADING_ID = "thread-details-ledger-heading";

/** The thread's ledger in the details card: what waits on the user and the topics in play. */
export function ThreadDetailsLedgerSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const { ledger } = useThreadLedger(threadRef);
  const ledgerSwitch = useLedgerSwitch(threadRef);
  // Hidden until the server answers, and on servers without a ledger.
  if (ledger === null) return null;
  return (
    <ThreadDetailsLedger
      ledger={ledger}
      canToggle={ledgerSwitch.canOperate && !ledgerSwitch.pending}
      onEnabledChange={(enabled) => void ledgerSwitch.setEnabled(enabled)}
      onOpen={() => useRightPanelStore.getState().open(threadRef, "ledger")}
    />
  );
}

export function ThreadDetailsLedger(props: {
  readonly ledger: LedgerDocument;
  readonly canToggle: boolean;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onOpen: () => void;
}) {
  const { ledger } = props;
  const ledgerSwitch = (
    <Switch
      size="sm"
      checked={ledger.enabled}
      disabled={!props.canToggle}
      onCheckedChange={(checked) => props.onEnabledChange(Boolean(checked))}
      aria-label="Ledger for this thread"
    />
  );

  if (!ledger.enabled) {
    return (
      <ThreadDetailsSection headingId={HEADING_ID} title="Ledger" showHeading={false}>
        <div className="relative">
          <ThreadDetailsControl onClick={props.onOpen}>
            <NotebookTextIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <span className={cn(THREAD_DETAILS_PANEL_LABEL_CLASS, "min-w-0 flex-1 truncate")}>
              Ledger
            </span>
            {/* The end margin keeps the label clear of the switch laid over the row. */}
            <span className="me-8.5 shrink-0 text-xs font-normal text-muted-foreground">Off</span>
          </ThreadDetailsControl>
          <span className="absolute right-2.5 top-1/2 flex -translate-y-1/2">{ledgerSwitch}</span>
        </div>
      </ThreadDetailsSection>
    );
  }

  const needs = needsYouCounts(ledger);
  const topics = cardTopics(ledger);
  const overflow = cardTopicsOverflowLabel(topics);
  const hasNeeds = needs.questions > 0 || needs.checks > 0;

  return (
    <ThreadDetailsSection
      headingId={HEADING_ID}
      title="Ledger"
      actions={
        <span className="flex items-center gap-2">
          {ledger.turns > 0 ? (
            <span className="text-2xs tabular-nums text-muted-foreground">turn {ledger.turns}</span>
          ) : null}
          {ledgerSwitch}
        </span>
      }
    >
      <div className="flex flex-col">
        {needs.questions > 0 ? (
          <ThreadDetailsControl onClick={props.onOpen}>
            <MessageCircleQuestionIcon
              aria-hidden
              className="size-4 shrink-0 text-question-foreground"
            />
            <span className={cn(THREAD_DETAILS_PANEL_LABEL_CLASS, "min-w-0 flex-1 truncate")}>
              {needs.questions} {needs.questions === 1 ? "question" : "questions"} for you
            </span>
          </ThreadDetailsControl>
        ) : null}
        {needs.checks > 0 ? (
          <ThreadDetailsControl onClick={props.onOpen}>
            <CircleIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
            <span className={cn(THREAD_DETAILS_PANEL_LABEL_CLASS, "min-w-0 flex-1 truncate")}>
              {needs.checks} {needs.checks === 1 ? "check" : "checks"} for you
            </span>
          </ThreadDetailsControl>
        ) : null}
        {hasNeeds && topics.shown.length > 0 ? (
          <div aria-hidden className="mx-2.5 my-1.5 h-px bg-border/65" />
        ) : null}
        {topics.shown.length > 0 ? (
          <ul aria-label="Topics in play" className="m-0 list-none p-0">
            {topics.shown.map((topic) => (
              <li
                key={topic.id}
                className="flex h-6.5 min-w-0 items-center gap-2 px-2.5 text-xs text-foreground/80"
              >
                <TopicStatusIcon status={topic.status} className="size-3" />
                <span className="min-w-0 flex-1 truncate">{topic.name}</span>
                <span
                  className={cn(
                    "shrink-0 text-2xs font-medium",
                    topicStatusToneClass(topic.status),
                  )}
                >
                  {TOPIC_STATUS_LABELS[topic.status]}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <ThreadDetailsControl className="h-6.5" onClick={props.onOpen}>
          <span className="min-w-0 flex-1 truncate text-xs font-normal text-muted-foreground">
            {overflow ?? (ledger.turns === 0 && !hasNeeds ? "Starts from the next turn" : "")}
          </span>
          <span className="shrink-0 text-2xs font-normal text-muted-foreground">Open ledger</span>
          <ArrowUpRightIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
        </ThreadDetailsControl>
      </div>
    </ThreadDetailsSection>
  );
}
