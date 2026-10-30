import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  LedgerDocument,
  LedgerItem,
  LedgerLiveTask,
  LedgerTopic,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleIcon,
  CircleXIcon,
  DiamondIcon,
  LoaderCircleIcon,
  MessageCircleQuestionIcon,
  MinusIcon,
  NotebookTextIcon,
  PenLineIcon,
  PlusIcon,
  ChevronDownIcon,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "../../lib/utils";
import { useThreadShell } from "../../state/entities";
import {
  type LedgerScribeSettings,
  useLedgerScribeSettings,
  useThreadLedger,
  useThreadWorkers,
} from "../../state/ledger";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  closedItemNote,
  closedTopics,
  formatLedgerCost,
  isClosedItem,
  ledgerModelLabel,
  ledgerUpdatedLabel,
  liveTaskProgress,
  liveTopics,
  needsYou,
  topicCounts,
  topicSections,
  topicStartsExpanded,
  topicSummary,
} from "./ledger.logic";
import { TopicStatusBadge, TopicStatusIcon } from "./ledgerPresentation";
import { type LedgerScope, LedgerScopeToggle, LedgerWorkersView } from "./LedgerWorkersView";
import { useLedgerSwitch } from "./useLedgerSwitch";

type LedgerView = "open" | "all";

/**
 * The right panel's Ledger tab: the thread's topics, what waits on the user, and the agent's task
 * list. A thread that launched workers (a Director) can switch to their rollup.
 */
export function ThreadLedgerPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { ledger, error } = useThreadLedger(threadRef);
  const thread = useThreadShell(threadRef);
  const scribe = useLedgerScribeSettings(threadRef);
  const ledgerSwitch = useLedgerSwitch(threadRef);
  const workers = useThreadWorkers(threadRef);
  const [scope, setScope] = useState<LedgerScope>("thread");
  const navigate = useNavigate();
  const title = thread?.title ?? "This thread";
  const scopeToggle =
    workers.length > 0 ? <LedgerScopeToggle value={scope} onChange={setScope} /> : undefined;
  if (scopeToggle !== undefined && scope === "workers") {
    return (
      <LedgerWorkersView
        title={title}
        workers={workers}
        scopeToggle={scopeToggle}
        onOpenWorker={(threadId) =>
          void navigate({
            to: "/$environmentId/$threadId",
            params: buildThreadRouteParams(scopeThreadRef(threadRef.environmentId, threadId)),
          })
        }
      />
    );
  }
  if (ledger === null) {
    return error === null ? null : (
      <LedgerEmptyState title="Ledger unavailable">{error}</LedgerEmptyState>
    );
  }
  return (
    <LedgerPanel
      ledger={ledger}
      title={title}
      scribe={scribe}
      canTurnOn={ledgerSwitch.canOperate && !ledgerSwitch.pending}
      onTurnOn={() => void ledgerSwitch.setEnabled(true)}
      {...(scopeToggle === undefined ? {} : { scopeToggle })}
    />
  );
}

export function LedgerPanel(props: {
  readonly ledger: LedgerDocument;
  readonly title: string;
  readonly scribe: LedgerScribeSettings;
  readonly canTurnOn: boolean;
  readonly onTurnOn: () => void;
  /** This thread or its workers, for a thread that launched some. */
  readonly scopeToggle?: ReactNode;
}) {
  if (!props.ledger.enabled) {
    return (
      <LedgerOffState
        canTurnOn={props.canTurnOn}
        onTurnOn={props.onTurnOn}
        title={props.title}
        scopeToggle={props.scopeToggle}
      />
    );
  }
  return (
    <LedgerOnView
      ledger={props.ledger}
      title={props.title}
      scribe={props.scribe}
      scopeToggle={props.scopeToggle}
    />
  );
}

function LedgerEmptyState(props: {
  readonly title: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <NotebookTextIcon aria-hidden className="size-6 text-muted-foreground/60" />
      <p className="text-sm font-medium">{props.title}</p>
      <p className="max-w-60 text-xs text-muted-foreground">{props.children}</p>
      {props.action}
    </div>
  );
}

function LedgerOffState(props: {
  readonly canTurnOn: boolean;
  readonly onTurnOn: () => void;
  readonly title: string;
  readonly scopeToggle: ReactNode | undefined;
}) {
  const empty = (
    <LedgerEmptyState
      title="Ledger is off for this thread"
      action={
        <>
          <Button size="sm" className="mt-1" disabled={!props.canTurnOn} onClick={props.onTurnOn}>
            Turn on ledger
          </Button>
          <p className="text-2xs text-muted-foreground">
            About a cent per turn at API prices. Starts from the next turn.
          </p>
        </>
      }
    >
      Turn it on to keep a running record of this thread's topics, open questions, decisions and
      to-dos. A small model reads each turn after it ends; nothing runs while it's off.
    </LedgerEmptyState>
  );
  if (props.scopeToggle === undefined) return empty;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 px-3.5 pt-3 pb-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-medium leading-4 text-foreground/90">
          {props.title}
        </h2>
        {props.scopeToggle}
      </header>
      <div className="min-h-0 flex-1">{empty}</div>
    </div>
  );
}

function LedgerOnView(props: {
  readonly ledger: LedgerDocument;
  readonly title: string;
  readonly scribe: LedgerScribeSettings;
  readonly scopeToggle: ReactNode | undefined;
}) {
  const { ledger, scribe } = props;
  const [view, setView] = useState<LedgerView>("open");
  const [open, setOpen] = useState({ working: true, needs: true, topics: true, done: false });
  const toggle = (section: keyof typeof open) =>
    setOpen((current) => ({ ...current, [section]: !current[section] }));
  const showClosed = view === "all";
  const needs = needsYou(ledger);
  const live = liveTopics(ledger);
  // Filed under its topic mid-turn; until then the task list stands on its own.
  const tasksTopic = live.some((topic) => topic.id === ledger.liveTopic)
    ? ledger.liveTopic
    : undefined;
  const closed = closedTopics(ledger);
  const progress = liveTaskProgress(ledger.liveTasks);
  const empty = ledger.topics.length === 0 && ledger.liveTasks.length === 0;

  return (
    <div className="flex h-full min-h-0 flex-col" data-ledger-panel>
      <header className="flex shrink-0 items-start gap-2 px-3.5 pt-3 pb-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="truncate text-sm font-medium leading-4 text-foreground/90">
            {props.title}
          </h2>
          <p className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
            <span className="line-clamp-2 break-words">{ledgerUpdatedLabel(ledger)}</span>
            {ledger.scribing ? (
              <span className="inline-flex shrink-0 items-center gap-1" role="status">
                <LoaderCircleIcon aria-hidden className="size-3 motion-safe:animate-spin" />
                Updating
              </span>
            ) : null}
          </p>
          {ledger.lastError ? (
            <p className="flex min-w-0 items-start gap-1 text-2xs text-muted-foreground">
              <CircleAlertIcon
                aria-hidden
                className="mt-0.5 size-3 shrink-0 text-warning-foreground"
              />
              <span className="line-clamp-2 break-words">
                Last update failed: {ledger.lastError}
              </span>
            </p>
          ) : null}
        </div>
        {props.scopeToggle}
        <ToggleGroup
          aria-label="Items to show"
          variant="segmented"
          className="shrink-0"
          value={[view]}
          onValueChange={(value) => {
            const next = value[0];
            if (next !== "open" && next !== "all") return;
            setView(next);
            // All means everything, so the folded Done section opens with it.
            if (next === "all") setOpen((current) => ({ ...current, done: true }));
          }}
        >
          <Toggle value="open">Open</Toggle>
          <Toggle value="all">All</Toggle>
        </ToggleGroup>
      </header>

      {empty ? (
        <LedgerEmptyState title="Nothing recorded yet">
          The ledger fills in after each turn: topics, questions for you, decisions and to-dos.
        </LedgerEmptyState>
      ) : (
        <ScrollArea scrollFade className="min-h-0 flex-1">
          <div className="flex flex-col gap-0.5 px-1.5 pt-0.5 pb-1.5">
            {ledger.liveTasks.length > 0 && tasksTopic === undefined ? (
              <LedgerSection
                label="Working now"
                count={`${progress.completed}/${progress.total}`}
                expanded={open.working}
                onToggle={() => toggle("working")}
              >
                <ul className="m-0 list-none p-0">
                  {ledger.liveTasks.map((task) => (
                    <LiveTaskRow key={task.id} task={task} />
                  ))}
                </ul>
              </LedgerSection>
            ) : null}

            {needs.length > 0 ? (
              <LedgerSection
                label="Needs you"
                count={String(needs.length)}
                expanded={open.needs}
                onToggle={() => toggle("needs")}
              >
                <ul className="m-0 list-none p-0">
                  {needs.map(({ item, topic }) => (
                    <NeedRow key={`${topic.id}:${item.id}`} item={item} topic={topic} />
                  ))}
                </ul>
              </LedgerSection>
            ) : null}

            {live.length > 0 ? (
              <LedgerSection
                label="Topics"
                count={String(live.length)}
                expanded={open.topics}
                onToggle={() => toggle("topics")}
              >
                <div className="flex flex-col gap-0.5">
                  {live.map((topic) => (
                    <TopicGroup
                      key={topic.id}
                      topic={topic}
                      showClosed={showClosed}
                      tasks={topic.id === tasksTopic ? ledger.liveTasks : undefined}
                    />
                  ))}
                </div>
              </LedgerSection>
            ) : null}

            {closed.length > 0 ? (
              <LedgerSection
                label="Done"
                count={String(closed.length)}
                expanded={open.done}
                onToggle={() => toggle("done")}
              >
                <div className="flex flex-col gap-0.5">
                  {closed.map((topic) => (
                    <TopicGroup key={topic.id} topic={topic} showClosed={showClosed} />
                  ))}
                </div>
              </LedgerSection>
            ) : null}
          </div>
        </ScrollArea>
      )}

      <footer className="flex shrink-0 items-center gap-2 border-t border-border/60 px-3.5 py-1.5 text-2xs text-muted-foreground">
        <PenLineIcon aria-hidden className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {ledgerModelLabel(scribe.turnModel)} each turn · {ledgerModelLabel(scribe.sweepModel)}{" "}
          cleanup every {scribe.sweepEvery}
        </span>
        <span className="shrink-0 tabular-nums">
          {formatLedgerCost(ledger.costUsd)} this thread
        </span>
      </footer>
    </div>
  );
}

function LedgerSection(props: {
  readonly label: string;
  readonly count: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
}) {
  return (
    <section aria-label={props.label} className="mt-1.5 first:mt-0">
      <CollapsibleSectionHeader
        variant="panel"
        expanded={props.expanded}
        onClick={props.onToggle}
        accessory={<span className="shrink-0 tabular-nums">{props.count}</span>}
      >
        {props.label}
      </CollapsibleSectionHeader>
      {props.expanded ? props.children : null}
    </section>
  );
}

/** The agent's task list, shown under the topic it was filed under whether or not that is open. */
function TopicLiveTasks({ tasks }: { tasks: ReadonlyArray<LedgerLiveTask> }) {
  const progress = liveTaskProgress(tasks);
  return (
    <div className="flex flex-col pb-1 pl-8">
      <span className="px-2 pt-1 text-2xs font-medium text-muted-foreground">
        Working now · {progress.completed}/{progress.total}
      </span>
      <ul className="m-0 list-none p-0">
        {tasks.map((task) => (
          <LiveTaskRow key={task.id} task={task} />
        ))}
      </ul>
    </div>
  );
}

function LiveTaskRow({ task }: { task: LedgerLiveTask }) {
  return (
    <li className="flex gap-2.5 rounded-lg px-2 py-1">
      {task.status === "completed" ? (
        <CircleCheckIcon
          aria-label="Done"
          className="mt-0.5 size-3.5 shrink-0 text-success-foreground"
        />
      ) : task.status === "in_progress" ? (
        <LoaderCircleIcon
          aria-label="In progress"
          className="mt-0.5 size-3.5 shrink-0 text-info-foreground motion-safe:animate-spin"
        />
      ) : (
        <CircleIcon
          aria-label="Not started"
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        />
      )}
      <span
        className={cn(
          "min-w-0 flex-1 text-sm leading-4.5",
          task.status === "completed" ? "text-muted-foreground" : "text-foreground/85",
        )}
      >
        {task.text}
      </span>
    </li>
  );
}

function NeedRow({ item, topic }: { item: LedgerItem; topic: LedgerTopic }) {
  const question = item.kind === "question";
  const meta = question
    ? item.rec
      ? `${topic.name} · Claude recommends: ${item.rec}`
      : topic.name
    : `${topic.name} · your check`;
  return (
    <li className="flex gap-2.5 rounded-lg px-2 py-1.5">
      {question ? (
        <MessageCircleQuestionIcon
          aria-label="Question"
          className={"mt-px size-4 shrink-0 text-question-foreground"}
        />
      ) : (
        <CircleIcon aria-label="Check" className="mt-px size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium leading-4.5 text-foreground/90">{item.text}</span>
        <span className="text-2xs text-muted-foreground">{meta}</span>
      </span>
    </li>
  );
}

function TopicGroup({
  topic,
  showClosed,
  tasks,
}: {
  topic: LedgerTopic;
  showClosed: boolean;
  tasks?: ReadonlyArray<LedgerLiveTask> | undefined;
}) {
  const [expanded, setExpanded] = useState(() => topicStartsExpanded(topic));
  const [revealClosed, setRevealClosed] = useState(false);
  const counts = topicCounts(topic);
  const sections = topicSections(topic, showClosed || revealClosed);
  const openCount = counts.openQuestions + counts.openTodos;
  const hasItems =
    sections.questions.length > 0 || sections.decided.length > 0 || sections.todos.length > 0;

  return (
    <div>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex min-h-8.5 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <TopicStatusIcon status={topic.status} className="size-3.5" />
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-foreground/90">{topic.name}</span>
            <TopicStatusBadge status={topic.status} />
          </span>
          {expanded ? null : (
            <span className="truncate text-2xs text-muted-foreground">{topicSummary(topic)}</span>
          )}
        </span>
        {expanded && openCount > 0 ? (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {openCount} open
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            !expanded && "-rotate-90",
          )}
        />
      </button>
      {tasks !== undefined && tasks.length > 0 ? <TopicLiveTasks tasks={tasks} /> : null}
      {expanded ? (
        <div className="flex flex-col pb-1 pl-8">
          {sections.questions.length > 0 ? (
            <TopicItemList label="Questions" items={sections.questions} />
          ) : null}
          {sections.decided.length > 0 ? (
            <TopicItemList label="Decided" items={sections.decided} />
          ) : null}
          {sections.todos.length > 0 ? (
            <TopicItemList label="To-dos" items={sections.todos} />
          ) : null}
          {!hasItems && sections.closedCount === 0 ? (
            <p className="px-2 py-1 text-2xs text-muted-foreground">Nothing recorded yet</p>
          ) : null}
          {!showClosed && sections.closedCount > 0 ? (
            <button
              type="button"
              aria-expanded={revealClosed}
              onClick={() => setRevealClosed(!revealClosed)}
              className="flex h-7 w-fit cursor-pointer items-center gap-2 rounded-lg px-2 text-xs font-medium text-muted-foreground/75 hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              {revealClosed ? (
                <MinusIcon aria-hidden className="size-3" />
              ) : (
                <PlusIcon aria-hidden className="size-3" />
              )}
              {revealClosed ? "Hide closed" : `Show ${sections.closedCount} closed`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function TopicItemList(props: {
  readonly label: string;
  readonly items: ReadonlyArray<LedgerItem>;
}) {
  return (
    <>
      <p className="px-2 pt-1.5 pb-0.5 text-2xs text-muted-foreground first:pt-1">{props.label}</p>
      <ul aria-label={props.label} className="m-0 list-none p-0">
        {props.items.map((item) => (
          <TopicItemRow key={item.id} item={item} />
        ))}
      </ul>
    </>
  );
}

const OWNER_LABELS = { claude: "Claude", user: "You" } as const;

function TopicItemRow({ item }: { item: LedgerItem }) {
  const closed = isClosedItem(item);
  const note = closed ? closedItemNote(item) : (item.note ?? null);
  const detail =
    item.kind === "question" && !closed && item.rec
      ? `Claude recommends: ${item.rec}`
      : (note ?? (item.state === "dropped" ? "Dropped" : null));
  return (
    <li className="flex gap-2.5 rounded-lg px-2 py-1">
      <TopicItemIcon item={item} />
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span
          className={cn(
            "text-sm leading-4.5",
            closed ? "text-muted-foreground" : "text-foreground/85",
          )}
        >
          {item.text}
        </span>
        {detail ? <span className="text-2xs text-muted-foreground">{detail}</span> : null}
      </span>
      {item.kind === "todo" && !closed ? (
        <span className="shrink-0 text-2xs leading-4.5 text-muted-foreground">
          {OWNER_LABELS[item.owner ?? "claude"]}
        </span>
      ) : null}
    </li>
  );
}

function TopicItemIcon({ item }: { item: LedgerItem }) {
  const className = "mt-0.5 size-3.5 shrink-0";
  if (item.kind === "question") {
    return item.state === "open" ? (
      <MessageCircleQuestionIcon
        aria-label="Open question"
        className={cn(className, "text-question-foreground")}
      />
    ) : (
      <MessageCircleQuestionIcon
        aria-label="Answered question"
        className={cn(className, "text-muted-foreground")}
      />
    );
  }
  if (item.kind === "decision") {
    return (
      <DiamondIcon
        aria-label={item.state === "recorded" ? "Decision" : "Dropped decision"}
        className={cn(
          className,
          "text-muted-foreground",
          item.state !== "recorded" && "opacity-60",
        )}
      />
    );
  }
  if (item.state === "done") {
    return (
      <CircleCheckIcon aria-label="Done" className={cn(className, "text-success-foreground")} />
    );
  }
  if (item.state === "dropped") {
    return <CircleXIcon aria-label="Dropped" className={cn(className, "text-muted-foreground")} />;
  }
  return <CircleIcon aria-label="Open to-do" className={cn(className, "text-muted-foreground")} />;
}
