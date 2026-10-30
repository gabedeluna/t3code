import type { LedgerTopicStatus } from "@t3tools/contracts";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleIcon,
  CirclePauseIcon,
  CircleXIcon,
  ClockIcon,
  type LucideIcon,
} from "lucide-react";
import type { CSSProperties } from "react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { TOPIC_STATUS_LABELS } from "./ledger.logic";

const STATUS_ICONS: Readonly<Record<LedgerTopicStatus, LucideIcon>> = {
  active: CircleDashedIcon,
  review: ClockIcon,
  chosen: CircleDotIcon,
  done: CircleCheckIcon,
  shaped: CircleIcon,
  exploring: CircleIcon,
  hold: CirclePauseIcon,
  rejected: CircleXIcon,
};

/** Work under way reads blue, a pending check amber, a chosen path indigo, finished green. */
export function topicStatusToneClass(status: LedgerTopicStatus): string {
  switch (status) {
    case "active":
      return "text-info-foreground";
    case "review":
      return "text-warning-foreground";
    case "chosen":
      return "text-question-foreground";
    case "done":
      return "text-success-foreground";
    default:
      return "text-muted-foreground";
  }
}

export function TopicStatusIcon({
  status,
  className,
}: {
  status: LedgerTopicStatus;
  className?: string;
}) {
  const Icon = STATUS_ICONS[status];
  return <Icon aria-hidden className={cn("shrink-0", topicStatusToneClass(status), className)} />;
}

const CHOSEN_BADGE_STYLE = { "--label": "var(--question)" } as CSSProperties;
// Parked and early topics take a grey tint; the secondary badge reads too bright in dark mode.
const MUTED_BADGE_STYLE = { "--label": "var(--color-muted-foreground)" } as CSSProperties;

export function TopicStatusBadge({ status }: { status: LedgerTopicStatus }) {
  const label = TOPIC_STATUS_LABELS[status];
  switch (status) {
    case "active":
      return (
        <Badge size="sm" variant="info">
          {label}
        </Badge>
      );
    case "review":
      return (
        <Badge size="sm" variant="warning">
          {label}
        </Badge>
      );
    case "done":
      return (
        <Badge size="sm" variant="success">
          {label}
        </Badge>
      );
    case "chosen":
      return (
        <Badge size="sm" variant="label" style={CHOSEN_BADGE_STYLE}>
          {label}
        </Badge>
      );
    default:
      return (
        <Badge size="sm" variant="label" style={MUTED_BADGE_STYLE}>
          {label}
        </Badge>
      );
  }
}
