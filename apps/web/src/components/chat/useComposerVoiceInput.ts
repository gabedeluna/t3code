import type { VoiceInputPhase } from "@t3tools/client-runtime/voice-input";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";

import { getClientSettings } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { registerCommands } from "../../shortcuts/dispatcher";
import { environmentProjects } from "../../state/projects";
import {
  ComposerVoiceSession,
  type ComposerVoiceError,
  type ComposerVoiceTarget,
} from "../../voiceInput/composerVoiceSession";
import {
  getDesktopVoiceInputBridge,
  type DesktopVoiceRequestOptions,
} from "../../voiceInput/desktopVoiceTranscriber";
import { registerVoiceHoldTarget } from "../../voiceInput/voiceHoldKey";
import { resolveVoiceKeyterms } from "../../voiceInput/voiceKeyterms";
import { toastManager } from "../ui/toast";

/** Where the dictation settings live, for errors that only Settings can fix. */
export const VOICE_INPUT_SETTINGS_SECTION_ID = "voice-input";

const NO_SUBSCRIPTION = () => () => {};
const IDLE_PHASE = (): VoiceInputPhase => "idle";

function readVoiceRequestOptions(): DesktopVoiceRequestOptions {
  const settings = getClientSettings();
  // Recent projects first, so the cap drops the stale ones.
  const projectNames = appAtomRegistry
    .get(environmentProjects.projectsAtom)
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((project) => project.title);
  return {
    languageCode: settings.voiceInputLanguage === "auto" ? null : settings.voiceInputLanguage,
    keyterms: resolveVoiceKeyterms(settings.voiceInputKeyterms, projectNames).keyterms,
  };
}

export interface ComposerVoiceInput {
  /** False outside the desktop app and in background threads. */
  readonly available: boolean;
  readonly phase: VoiceInputPhase;
  /** Sending waits until the transcript lands. */
  readonly busy: boolean;
  readonly toggle: () => void;
}

/**
 * Dictation into this composer: the mic button, the dictate shortcut, hold-to-talk and Esc.
 * The transcript lands at the cursor where dictation started. It never sends.
 */
export function useComposerVoiceInput(input: {
  readonly enabled: boolean;
  readonly readTarget: () => ComposerVoiceTarget | null;
}): ComposerVoiceInput {
  const navigate = useNavigate();
  const readTarget = useStableCallback(input.readTarget);
  const showError = useStableCallback((error: ComposerVoiceError) => {
    if (error.kind === "unplaced-transcript") {
      const id = toastManager.add({
        type: "warning",
        title: "Transcript not added",
        description: "You moved to another draft while dictating.",
        actionProps: {
          children: "Copy transcript",
          onClick: () => {
            toastManager.close(id);
            void navigator.clipboard.writeText(error.transcript).catch(() => undefined);
          },
        },
      });
      return;
    }
    const id = toastManager.add({
      type: error.tone,
      title: error.message,
      ...(error.opensSettings
        ? {
            actionProps: {
              children: "Open settings",
              onClick: () => {
                toastManager.close(id);
                void navigate({ to: "/settings/chat", hash: VOICE_INPUT_SETTINGS_SECTION_ID });
              },
            },
          }
        : {}),
    });
  });
  const [session] = useState(() => {
    const bridge = getDesktopVoiceInputBridge();
    return bridge
      ? new ComposerVoiceSession({
          bridge,
          readTarget,
          readRequestOptions: readVoiceRequestOptions,
          onError: showError,
        })
      : null;
  });
  const activeSession = input.enabled ? session : null;
  const phase = useSyncExternalStore(
    activeSession?.subscribe ?? NO_SUBSCRIPTION,
    activeSession?.getPhase ?? IDLE_PHASE,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers hold-to-talk and the dictate and Esc keys while this composer can take dictation
  useEffect(() => {
    if (!activeSession) return;
    const unregisterHold = registerVoiceHoldTarget(
      activeSession.holdTarget(() => getClientSettings().voiceInputHoldKey),
    );
    // Capture phase, so Esc cancels before the editor or an open menu consumes it.
    const unregisterKeys = registerCommands(
      {
        "composer.dictate": (event) => {
          event.preventDefault();
          if (!event.repeat) void activeSession.toggle();
        },
      },
      {
        capture: true,
        onKeyDown: (event) => {
          if (event.key !== "Escape" || !activeSession.isBusy()) return false;
          event.preventDefault();
          activeSession.cancel();
          return true;
        },
      },
    );
    return () => {
      unregisterHold();
      unregisterKeys();
      activeSession.dispose();
    };
  }, [activeSession]);

  return {
    available: activeSession !== null,
    phase,
    busy: phase === "preparing" || phase === "recording" || phase === "transcribing",
    toggle: () => void activeSession?.toggle(),
  };
}
