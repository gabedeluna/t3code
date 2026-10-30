import type { LedgerWorker, LedgerWorkerGroup, ThreadId } from "@t3tools/contracts";
import { CircleDashedIcon, CircleIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { cn } from "../../lib/utils";
import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { ScrollArea } from "../ui/scroll-area";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  WORKER_STATE_LABELS,
  workerGroups,
  workerLine,
  workerMeta,
  workersSubtitle,
  workerStateToneClass,
} from "./workers.logic";

export type LedgerScope = "thread" | "workers";

/** Switches the ledger panel between this thread's ledger and the threads it launched. */
export function LedgerScopeToggle(props: {
  readonly value: LedgerScope;
  readonly onChange: (scope: LedgerScope) => void;
}) {
  return (
    <ToggleGroup
      aria-label="Ledger to show"
      variant="segmented"
      className="shrink-0"
      value={[props.value]}
      onValueChange={(value) => {
        const next = value[0];
        if (next === "thread" || next === "workers") props.onChange(next);
      }}
    >
      <Toggle value="thread">This thread</Toggle>
      <Toggle value="workers">Workers</Toggle>
    </ToggleGroup>
  );
}

/** A Director's workers, grouped by what they need: each from its own ledger and status. */
export function LedgerWorkersView(props: {
  readonly title: string;
  readonly workers: ReadonlyArray<LedgerWorker>;
  readonly scopeToggle: ReactNode;
  readonly onOpenWorker: (threadId: ThreadId) => void;
}) {
  const [folded, setFolded] = useState<ReadonlySet<LedgerWorkerGroup>>(() => new Set(["settled"]));
  const toggle = (group: LedgerWorkerGroup) =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(group)) next.add(group);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col" data-ledger-workers>
      <header className="flex shrink-0 items-center gap-2 px-3.5 pt-3 pb-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <h2 className="truncate text-sm font-medium leading-4 text-foreground/90">
            {props.title}
          </h2>
          <p className="truncate text-2xs text-muted-foreground">
            {workersSubtitle(props.workers.length)}
          </p>
        </div>
        {props.scopeToggle}
      </header>
      <ScrollArea scrollFade className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 px-1.5 pt-0.5 pb-1.5">
          {workerGroups(props.workers).map(({ group, label, workers }) => {
            const expanded = !folded.has(group);
            return (
              <section key={group} aria-label={label} className="mt-1.5 first:mt-0">
                <CollapsibleSectionHeader
                  variant="panel"
                  expanded={expanded}
                  onClick={() => toggle(group)}
                  accessory={<span className="shrink-0 tabular-nums">{workers.length}</span>}
                >
                  {label}
                </CollapsibleSectionHeader>
                {expanded ? (
                  <ul className="m-0 list-none p-0">
                    {workers.map((worker) => (
                      <WorkerRow
                        key={worker.threadId}
                        worker={worker}
                        onOpen={() => props.onOpenWorker(worker.threadId)}
                      />
                    ))}
                  </ul>
                ) : null}
              </section>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

function WorkerRow({ worker, onOpen }: { worker: LedgerWorker; onOpen: () => void }) {
  const StateIcon = worker.state === "working" ? CircleDashedIcon : CircleIcon;
  const meta = workerMeta(worker);
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-2 py-2 text-left hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium leading-4 text-foreground/90">
            {worker.title}
          </span>
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 text-xs font-medium",
              workerStateToneClass(worker.state),
            )}
          >
            <StateIcon aria-hidden className="size-3" />
            {WORKER_STATE_LABELS[worker.state]}
          </span>
        </span>
        <span className="text-sm leading-4.5 text-foreground/80">{workerLine(worker)}</span>
        {meta ? <span className="text-2xs text-muted-foreground">{meta}</span> : null}
      </button>
    </li>
  );
}
