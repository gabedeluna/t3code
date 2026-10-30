import {
  VOICE_RECORDING_LIMIT_SECONDS,
  type VoiceInputPhase,
} from "@t3tools/client-runtime/voice-input";
import {
  type DesktopVoiceStream,
  type DesktopVoiceStreamEvent,
  type DesktopVoiceTranscriptionFailureReason,
  VOICE_INPUT_STREAM_SAMPLE_RATE,
} from "@t3tools/contracts";

import type { ComposerDictationPreview } from "../components/composerDictationPreview";
import {
  type ComposerVoiceError,
  type ComposerVoiceTarget,
  MIN_VOICE_HOLD_MS,
  microphoneFailure,
  NO_SPEECH_ERROR,
  spaceInsertion,
  voiceFailureError,
} from "./composerVoiceSession";
import type {
  DesktopVoiceInputBridge,
  DesktopVoiceRequestOptions,
} from "./desktopVoiceTranscriber";
import type { OpenPcmCapture, PcmCapture } from "./pcmCapture";
import type { VoiceHoldTarget } from "./voiceHoldKey";
import { encodeWav } from "./wav";

// Batch would fail the same way, so these end the dictation instead of falling back.
const FATAL_STREAM_FAILURES = new Set<DesktopVoiceTranscriptionFailureReason>([
  "missing-key",
  "invalid-key",
  "quota-exceeded",
]);
// Less audio than this holds no words worth a batch request.
const MIN_FALLBACK_SAMPLES = (VOICE_INPUT_STREAM_SAMPLE_RATE * MIN_VOICE_HOLD_MS) / 1_000;
// The main process ends a finishing stream within 4 s; silence past this means it never will.
const FINISH_DEADLINE_MS = 6_000;

export interface StreamingVoiceRequestOptions extends DesktopVoiceRequestOptions {
  /** At most 50 short terms, which is all Scribe v2 Realtime takes. */
  readonly realtimeKeyterms: ReadonlyArray<string>;
}

/** One dictation: where its words go in the draft and what has been placed there so far. */
interface Dictation {
  readonly ownerKey: string;
  readonly options: StreamingVoiceRequestOptions;
  /** Where the dictated text starts, in the draft's expanded coordinates. */
  start: number;
  /** Exactly what this dictation has put in the draft at `start`. */
  placed: string;
  /** Committed words the draft could not take, offered for copying at the end. */
  unplaced: string;
  partial: string;
  readonly audio: Int16Array[];
  samples: number;
  capture: PcmCapture | null;
  /** Null once the stream ends; after a failure the dictation finishes through batch. */
  stream: DesktopVoiceStream | null;
  streamFailed: boolean;
  /** The recording limit while listening, then the deadline for the stream's last phrase. */
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Live dictation through Scribe v2 Realtime: committed phrases land in the draft as they are
 * spoken, and the phrase still being heard shows faded beside them. The audio is also kept,
 * so a stream that fails or drops finishes the dictation through batch and loses nothing.
 */
export class ComposerStreamingSession {
  private readonly bridge: DesktopVoiceInputBridge;
  private readonly readTarget: () => ComposerVoiceTarget | null;
  private readonly readRequestOptions: () => StreamingVoiceRequestOptions;
  private readonly showPreview: (preview: ComposerDictationPreview | null) => void;
  private readonly onError: (error: ComposerVoiceError) => void;
  private readonly openCapture: OpenPcmCapture;
  private readonly listeners = new Set<() => void>();
  private phase: VoiceInputPhase = "idle";
  private dictation: Dictation | null = null;
  private holdStartedAt: number | null = null;

  constructor(dependencies: {
    readonly bridge: DesktopVoiceInputBridge;
    readonly readTarget: () => ComposerVoiceTarget | null;
    readonly readRequestOptions: () => StreamingVoiceRequestOptions;
    readonly showPreview: (preview: ComposerDictationPreview | null) => void;
    readonly onError: (error: ComposerVoiceError) => void;
    readonly openCapture: OpenPcmCapture;
  }) {
    this.bridge = dependencies.bridge;
    this.readTarget = dependencies.readTarget;
    this.readRequestOptions = dependencies.readRequestOptions;
    this.showPreview = dependencies.showPreview;
    this.onError = dependencies.onError;
    this.openCapture = dependencies.openCapture;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getPhase = (): VoiceInputPhase => this.phase;

  readonly isBusy = (): boolean => this.phase !== "idle";

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
      if (this.phase !== "recording" || atMs - startedAt < MIN_VOICE_HOLD_MS) {
        this.cancel();
        return;
      }
      return this.finish();
    },
    abort: () => {
      if (this.holdStartedAt === null) return;
      this.holdStartedAt = null;
      this.cancel();
    },
  });

  /** Settles once the microphone is live, or failed to open. */
  async start(): Promise<void> {
    if (this.isBusy()) return;
    const target = this.readTarget();
    if (!target) return;
    const dictation: Dictation = {
      ownerKey: target.ownerKey,
      options: this.readRequestOptions(),
      start: Math.max(0, Math.min(target.cursor, target.text.length)),
      placed: "",
      unplaced: "",
      partial: "",
      audio: [],
      samples: 0,
      capture: null,
      stream: null,
      streamFailed: false,
      timer: null,
    };
    this.dictation = dictation;
    this.setPhase("preparing");

    const status = await this.bridge.getStatus().catch(() => null);
    if (this.dictation !== dictation) return;
    if (status && !status.apiKeyConfigured) {
      this.end(dictation);
      this.onError(voiceFailureError("missing-key"));
      return;
    }
    // Connecting overlaps with the microphone warming up; audio waits in the main process.
    dictation.stream = this.bridge.openStream(
      {
        languageCode: dictation.options.languageCode,
        keyterms: dictation.options.realtimeKeyterms,
      },
      (event) => this.handleStreamEvent(dictation, event),
    );
    try {
      const capture = await this.openCapture({
        onChunk: (pcm) => this.handleAudio(dictation, pcm),
        onEnded: () => void this.finish(),
      });
      if (this.dictation !== dictation) {
        capture.close();
        return;
      }
      dictation.capture = capture;
    } catch (error) {
      if (this.dictation !== dictation) return;
      this.end(dictation);
      const failure = microphoneFailure(error);
      this.onError(
        failure === null
          ? {
              kind: "message",
              message: "Could not start the microphone.",
              tone: "error",
              opensSettings: false,
            }
          : voiceFailureError(failure),
      );
      return;
    }
    dictation.timer = setTimeout(() => void this.finish(), VOICE_RECORDING_LIMIT_SECONDS * 1_000);
    this.setPhase("recording");
  }

  /** The mic button and the dictate shortcut. */
  toggle(): Promise<void> {
    if (this.phase === "recording") return this.finish();
    if (this.phase === "preparing") this.cancel();
    else if (this.phase === "idle") return this.start();
    return Promise.resolve();
  }

  /** Stops listening and settles once the last phrase is in the draft. */
  async finish(): Promise<void> {
    const dictation = this.dictation;
    if (!dictation || this.phase !== "recording") return;
    this.setPhase("transcribing");
    if (dictation.timer !== null) clearTimeout(dictation.timer);
    await dictation.capture?.stop();
    dictation.capture = null;
    if (this.dictation !== dictation) return;
    if (dictation.stream) {
      // The stream's `finished` or `failed` event completes the dictation.
      dictation.stream.finish();
      dictation.timer = setTimeout(() => {
        if (!dictation.stream) return;
        dictation.stream.close();
        this.handleStreamEvent(dictation, { _tag: "failed", reason: "unreachable" });
      }, FINISH_DEADLINE_MS);
      return;
    }
    await this.finishThroughBatch(dictation);
  }

  /** Esc: stops listening and takes back what this dictation put in the draft. */
  cancel(): void {
    const dictation = this.dictation;
    this.holdStartedAt = null;
    if (!dictation) return;
    this.end(dictation);
    const target = this.readOwnTarget(dictation);
    if (target && dictation.placed !== "" && this.placedIntact(dictation, target)) {
      target.insert(dictation.start, dictation.start + dictation.placed.length, "");
    }
  }

  dispose(): void {
    this.holdStartedAt = null;
    if (this.dictation) this.end(this.dictation);
  }

  private handleAudio(dictation: Dictation, pcm: Int16Array): void {
    if (this.dictation !== dictation) return;
    dictation.audio.push(pcm);
    dictation.samples += pcm.length;
    dictation.stream?.sendAudio(pcm.slice().buffer);
  }

  private handleStreamEvent(dictation: Dictation, event: DesktopVoiceStreamEvent): void {
    if (this.dictation !== dictation) return;
    switch (event._tag) {
      case "partial":
        dictation.partial = event.text.trim();
        this.renderPreview(dictation);
        return;
      case "committed":
        dictation.partial = "";
        this.place(dictation, event.text.trim());
        this.renderPreview(dictation);
        return;
      case "finished":
        dictation.stream = null;
        this.complete(dictation);
        return;
      case "failed":
        dictation.stream = null;
        dictation.streamFailed = true;
        dictation.partial = "";
        this.renderPreview(dictation);
        if (FATAL_STREAM_FAILURES.has(event.reason)) {
          this.end(dictation);
          this.onError(voiceFailureError(event.reason));
          return;
        }
        // Still recording: the rest of the dictation goes to batch when it stops.
        if (this.phase === "transcribing") void this.finishThroughBatch(dictation);
    }
  }

  private place(dictation: Dictation, words: string): void {
    if (words === "") return;
    const target = this.readOwnTarget(dictation);
    if (!target) {
      dictation.unplaced = dictation.unplaced === "" ? words : `${dictation.unplaced} ${words}`;
      return;
    }
    // Edits inside the dictated text move it to wherever the cursor is now.
    if (!this.placedIntact(dictation, target)) {
      dictation.start = Math.max(0, Math.min(target.cursor, target.text.length));
      dictation.placed = "";
    }
    const at = dictation.start + dictation.placed.length;
    const piece = spaceInsertion(target.text, at, words);
    if (target.insert(at, at, piece)) dictation.placed += piece;
    else dictation.unplaced = dictation.unplaced === "" ? words : `${dictation.unplaced} ${words}`;
  }

  /** Replaces what the stream placed with a batch transcript of the whole recording. */
  private async finishThroughBatch(dictation: Dictation): Promise<void> {
    if (dictation.samples < MIN_FALLBACK_SAMPLES) {
      this.complete(dictation);
      return;
    }
    const result = await this.bridge
      .transcribe({
        audio: encodeWav(dictation.audio),
        mimeType: "audio/wav",
        languageCode: dictation.options.languageCode,
        keyterms: dictation.options.keyterms,
      })
      .catch(() => ({ _tag: "failed", reason: "unreachable" }) as const);
    if (this.dictation !== dictation) return;
    if (result._tag === "failed") {
      this.end(dictation);
      this.onError(voiceFailureError(result.reason));
      return;
    }
    const transcript = result.text.trim();
    const target = this.readOwnTarget(dictation);
    if (transcript === "") {
      this.end(dictation);
      if (dictation.placed === "") this.onError(NO_SPEECH_ERROR);
      return;
    }
    if (target && this.placedIntact(dictation, target)) {
      const end = dictation.start + dictation.placed.length;
      const around = target.text.slice(0, dictation.start) + target.text.slice(end);
      const piece = spaceInsertion(around, dictation.start, transcript);
      if (target.insert(dictation.start, end, piece)) {
        dictation.placed = piece;
        dictation.unplaced = "";
        this.end(dictation);
        return;
      }
    }
    // The draft moved on, so the full transcript is offered instead of guessed into place.
    dictation.unplaced = transcript;
    this.complete(dictation);
  }

  private complete(dictation: Dictation): void {
    this.end(dictation);
    if (dictation.unplaced !== "") {
      this.onError({ kind: "unplaced-transcript", transcript: dictation.unplaced });
    } else if (dictation.placed === "" && !dictation.streamFailed) {
      this.onError(NO_SPEECH_ERROR);
    }
  }

  /** Releases the microphone and the stream; the draft keeps what was placed. */
  private end(dictation: Dictation): void {
    if (this.dictation !== dictation) return;
    this.dictation = null;
    if (dictation.timer !== null) clearTimeout(dictation.timer);
    dictation.capture?.close();
    dictation.stream?.close();
    dictation.stream = null;
    this.showPreview(null);
    this.setPhase("idle");
  }

  private renderPreview(dictation: Dictation): void {
    const target = this.readOwnTarget(dictation);
    if (!target || dictation.partial === "") {
      this.showPreview(null);
      return;
    }
    const at = this.placedIntact(dictation, target)
      ? dictation.start + dictation.placed.length
      : Math.max(0, Math.min(target.cursor, target.text.length));
    this.showPreview({ at, text: spaceInsertion(target.text, at, dictation.partial) });
  }

  private readOwnTarget(dictation: Dictation): ComposerVoiceTarget | null {
    const target = this.readTarget();
    return target && target.ownerKey === dictation.ownerKey ? target : null;
  }

  private placedIntact(dictation: Dictation, target: ComposerVoiceTarget): boolean {
    return (
      target.text.slice(dictation.start, dictation.start + dictation.placed.length) ===
      dictation.placed
    );
  }

  private setPhase(phase: VoiceInputPhase): void {
    if (this.phase === phase) return;
    this.phase = phase;
    for (const listener of this.listeners) listener();
  }
}
