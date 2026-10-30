import { secondTick } from "@t3tools/client-runtime/clock";
import type { VoiceInputPhase } from "@t3tools/client-runtime/voice-input";
import { LoaderCircleIcon, MicIcon, SquareIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Mounted when recording starts, so it counts from zero. */
function RecordingElapsed() {
  const now = useSyncExternalStore(secondTick.subscribe, secondTick.getSnapshot);
  const [startedAt] = useState(now);
  const seconds = Math.max(0, Math.round((now - startedAt) / 1_000));
  return (
    <span className="tabular-nums">{`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}</span>
  );
}

function phaseLabel(phase: VoiceInputPhase): string {
  switch (phase) {
    case "preparing":
      return "Starting the microphone";
    case "recording":
      return "Stop and transcribe";
    case "transcribing":
      return "Transcribing";
    default:
      return "Dictate";
  }
}

/** Click to start and again to stop; the transcript lands at the cursor. Esc cancels. */
export function ComposerDictationButton(props: {
  readonly phase: VoiceInputPhase;
  /** The dictate shortcut and the hold key, as labels; either may be missing. */
  readonly shortcutLabel: string | null;
  readonly holdKeyLabel: string | null;
  readonly onToggle: () => void;
}) {
  const recording = props.phase === "recording";
  const working = props.phase === "preparing" || props.phase === "transcribing";
  const hints =
    recording || working
      ? ["Esc cancels"]
      : [props.shortcutLabel, props.holdKeyLabel ? `hold ${props.holdKeyLabel}` : null].filter(
          (hint): hint is string => hint !== null,
        );
  const label = phaseLabel(props.phase);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant={recording ? "destructive-outline" : "ghost"}
            size={recording ? "sm" : "icon-sm"}
            // Keeps the editor focused, so its cursor stays where the transcript goes.
            onPointerDown={(event) => event.preventDefault()}
            onClick={props.onToggle}
            aria-label={label}
            aria-pressed={recording}
            aria-busy={working}
            data-dictation-phase={props.phase}
          />
        }
      >
        {working ? (
          <LoaderCircleIcon className="animate-spin" />
        ) : recording ? (
          <>
            <SquareIcon className="fill-current" />
            <RecordingElapsed />
          </>
        ) : (
          <MicIcon />
        )}
      </TooltipTrigger>
      <TooltipPopup>{hints.length > 0 ? `${label} (${hints.join(", ")})` : label}</TooltipPopup>
    </Tooltip>
  );
}
