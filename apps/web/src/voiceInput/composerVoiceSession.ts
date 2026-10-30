import {
  VoiceInputController,
  voiceInputBlocksSubmission,
  type VoiceInputPhase,
  type VoiceInputState,
  type VoiceRecorderStatus,
} from "@t3tools/client-runtime/voice-input";
import type { DesktopVoiceTranscriptionFailureReason } from "@t3tools/contracts";

import {
  createDesktopVoiceTranscriber,
  type DesktopVoiceInputBridge,
  type DesktopVoiceRequestOptions,
} from "./desktopVoiceTranscriber";
import type { VoiceHoldTarget } from "./voiceHoldKey";
import { type MicrophoneRecorder, WebVoiceRecorder } from "./webVoiceRecorder";

/** A shorter hold is a tap, not speech worth a request. */
export const MIN_VOICE_HOLD_MS = 300;

export interface ComposerVoiceTarget {
  /** Changes when the draft being written changes, such as another thread or question. */
  readonly ownerKey: string;
  readonly text: string;
  /** In `text`'s coordinates, with inline chips expanded. */
  readonly cursor: number;
  readonly insert: (start: number, end: number, text: string) => boolean;
}

export type ComposerVoiceError =
  | {
      readonly kind: "message";
      readonly message: string;
      /** "info" for a recording with no speech in it, which is not a failure. */
      readonly tone: "error" | "info";
      readonly opensSettings: boolean;
    }
  /** The transcript arrived after the composer left its draft, so the user can still take it. */
  | { readonly kind: "unplaced-transcript"; readonly transcript: string };

type MicrophoneFailure = "microphone-blocked" | "microphone-missing" | "microphone-busy";

const FAILURE_MESSAGES: Record<DesktopVoiceTranscriptionFailureReason | MicrophoneFailure, string> =
  {
    "missing-key": "Add your ElevenLabs API key in Settings to dictate.",
    "invalid-key": "ElevenLabs rejected the API key. Check it in Settings.",
    "quota-exceeded": "Your ElevenLabs account is out of transcription credits.",
    "rate-limited": "ElevenLabs is busy. Try again in a moment.",
    rejected: "ElevenLabs could not read this recording.",
    unreachable: "Could not reach ElevenLabs. Check your connection.",
    failed: "ElevenLabs could not transcribe this recording. Try again.",
    "microphone-blocked": "Microphone access is blocked. Allow it in your system privacy settings.",
    "microphone-missing": "No microphone was found.",
    "microphone-busy": "The microphone is in use by another app.",
  };
const SETTINGS_FAILURES = new Set<string>(["missing-key", "invalid-key"]);

function microphoneFailure(error: unknown): MicrophoneFailure | null {
  if (!(error instanceof DOMException)) return null;
  if (error.name === "NotAllowedError" || error.name === "SecurityError") {
    return "microphone-blocked";
  }
  if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
    return "microphone-missing";
  }
  if (error.name === "NotReadableError" || error.name === "AbortError") return "microphone-busy";
  return null;
}

async function requestMicrophonePermission() {
  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    if (status.state === "denied") return { granted: false, canAskAgain: false };
  } catch {}
  // Prompting happens when the microphone opens.
  return { granted: true, canAskAgain: true };
}

/**
 * One composer's dictation: the shared controller with a microphone recorder and the desktop
 * transcriber. Errors leave the controller in its error phase, which starts over cleanly, and
 * the UI shows them through `onError` instead.
 */
export class ComposerVoiceSession {
  private readonly controller: VoiceInputController;
  private readonly recorder: MicrophoneRecorder;
  private readonly readTarget: () => ComposerVoiceTarget | null;
  private readonly onError: (error: ComposerVoiceError) => void;
  private readonly listeners = new Set<() => void>();
  private phase: VoiceInputPhase = "idle";
  private selection: { readonly start: number; readonly end: number } | null = null;
  private ownerKey: string | null = null;
  private failure: DesktopVoiceTranscriptionFailureReason | MicrophoneFailure | null = null;
  private transcript: string | null = null;
  private holdStartedAt: number | null = null;

  constructor(dependencies: {
    readonly bridge: DesktopVoiceInputBridge;
    readonly readTarget: () => ComposerVoiceTarget | null;
    readonly readRequestOptions: () => DesktopVoiceRequestOptions;
    readonly onError: (error: ComposerVoiceError) => void;
    readonly createRecorder?: (
      onStatus: (status: VoiceRecorderStatus) => void,
    ) => MicrophoneRecorder;
  }) {
    this.readTarget = dependencies.readTarget;
    this.onError = dependencies.onError;
    const createRecorder =
      dependencies.createRecorder ?? ((onStatus) => new WebVoiceRecorder(onStatus));
    this.recorder = createRecorder((status) => {
      void this.controller.handleRecorderStatus(status);
    });
    const transcriber = createDesktopVoiceTranscriber({
      bridge: dependencies.bridge,
      readRecording: (uri) => this.recorder.readRecording(uri),
      readRequestOptions: dependencies.readRequestOptions,
      onFailure: (reason) => {
        this.failure = reason;
      },
      onTranscript: (text) => {
        this.transcript = text;
      },
    });
    this.controller = new VoiceInputController({
      recorder: this.recorder,
      getTranscriber: () => transcriber,
      requestPermission: requestMicrophonePermission,
      configureRecording: async () => {
        try {
          await this.recorder.open();
        } catch (error) {
          this.failure = microphoneFailure(error);
          throw error;
        }
      },
      releaseRecording: async () => this.recorder.close(),
      deleteRecording: (uri) => this.recorder.deleteRecording(uri),
      readDraft: () => {
        const target = this.readTarget();
        if (!target || !this.selection) return null;
        return {
          ownerKey: target.ownerKey,
          text: target.text,
          selection: this.selection,
          revision: 0,
        };
      },
      commitDraft: (text, selection) => {
        const captured = this.selection;
        const target = this.readTarget();
        if (!captured || !target) return;
        // The controller hands back the whole draft; the composer applies just the insertion,
        // so inline chips and undo history around it stay intact.
        const inserted = text.slice(captured.start, selection.end);
        if (!target.insert(captured.start, captured.end, inserted)) {
          this.onError({ kind: "unplaced-transcript", transcript: inserted.trim() });
        }
      },
      onStateChange: (state) => this.handleStateChange(state),
    });
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** "error" never shows: the error is reported once and the next start begins afresh. */
  readonly getPhase = (): VoiceInputPhase => (this.phase === "error" ? "idle" : this.phase);

  readonly isBusy = (): boolean => voiceInputBlocksSubmission(this.controller.currentState);

  readonly holdTarget = (holdKey: () => string | null): VoiceHoldTarget => ({
    holdKey,
    press: (atMs) => {
      if (this.isBusy()) return;
      this.holdStartedAt = atMs;
      return this.start();
    },
    release: (atMs) => {
      const startedAt = this.holdStartedAt;
      this.holdStartedAt = null;
      if (startedAt === null) return;
      // Released before the microphone opened, or too soon to hold speech.
      if (
        this.controller.currentState.phase !== "recording" ||
        atMs - startedAt < MIN_VOICE_HOLD_MS
      ) {
        this.cancel();
        return;
      }
      return this.controller.stop();
    },
    abort: () => {
      if (this.holdStartedAt === null) return;
      this.holdStartedAt = null;
      this.cancel();
    },
  });

  /** Settles once recording has started, or failed to. */
  start(): Promise<void> {
    if (this.isBusy()) return Promise.resolve();
    const target = this.readTarget();
    if (!target) return Promise.resolve();
    const cursor = Math.max(0, Math.min(target.cursor, target.text.length));
    this.selection = { start: cursor, end: cursor };
    this.ownerKey = target.ownerKey;
    this.failure = null;
    this.transcript = null;
    return this.controller.start();
  }

  /** The mic button and the dictate shortcut. Stopping settles once the transcript is placed. */
  toggle(): Promise<void> {
    const { phase } = this.controller.currentState;
    if (phase === "recording") return this.controller.stop();
    if (phase === "preparing") this.cancel();
    else if (phase !== "transcribing") return this.start();
    return Promise.resolve();
  }

  cancel(): void {
    this.holdStartedAt = null;
    this.controller.cancel();
  }

  dispose(): void {
    this.holdStartedAt = null;
    this.controller.dispose();
  }

  private handleStateChange(state: VoiceInputState): void {
    const previous = this.phase;
    this.phase = state.phase;
    if (state.phase === "error" && previous !== "error") this.reportError(state);
    for (const listener of this.listeners) listener();
  }

  private reportError(state: VoiceInputState): void {
    const transcript = this.transcript?.trim() ?? null;
    if (transcript) {
      if (!this.insertAtCurrentCursor(transcript)) {
        this.onError({ kind: "unplaced-transcript", transcript });
      }
      return;
    }
    if (transcript === "") {
      this.onError({
        kind: "message",
        message: "No speech was detected.",
        tone: "info",
        opensSettings: false,
      });
      return;
    }
    const failure = this.failure;
    this.onError({
      kind: "message",
      message: failure === null ? (state.error ?? "Dictation failed.") : FAILURE_MESSAGES[failure],
      tone: "error",
      opensSettings: failure !== null && SETTINGS_FAILURES.has(failure),
    });
  }

  /**
   * The controller drops a transcript when the draft changed while it ran. Typing in the same
   * draft meanwhile should not cost the dictation, so it lands at the cursor as it is now.
   */
  private insertAtCurrentCursor(transcript: string): boolean {
    const target = this.readTarget();
    if (!target || target.ownerKey !== this.ownerKey) return false;
    const cursor = Math.max(0, Math.min(target.cursor, target.text.length));
    const before = target.text[cursor - 1];
    const after = target.text[cursor];
    const leading = before !== undefined && !/\s/.test(before) ? " " : "";
    const trailing = after !== undefined && !/\s/.test(after) ? " " : "";
    return target.insert(cursor, cursor, `${leading}${transcript}${trailing}`);
  }
}
