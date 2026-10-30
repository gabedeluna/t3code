import {
  throwIfVoiceTranscriptionAborted,
  VoiceTranscriptionError,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";
import type { DesktopBridge, DesktopVoiceTranscriptionFailureReason } from "@t3tools/contracts";

import type { CapturedRecording } from "./webVoiceRecorder";

export type DesktopVoiceInputBridge = DesktopBridge["voiceInput"];

export function getDesktopVoiceInputBridge(): DesktopVoiceInputBridge | undefined {
  return typeof window === "undefined" ? undefined : window.desktopBridge?.voiceInput;
}

export interface DesktopVoiceRequestOptions {
  /** Null lets ElevenLabs detect the language. */
  readonly languageCode: string | null;
  readonly keyterms: ReadonlyArray<string>;
}

/**
 * The main process cannot cancel its ElevenLabs request across IPC, so an abort settles at
 * once and the late result is dropped. Nothing else waits on that request, so settling
 * early cannot race shared work the way the transcription contract guards against.
 */
function settleOnAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () =>
      reject(new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled."));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** ElevenLabs Scribe through the desktop main process, which holds the API key. */
export function createDesktopVoiceTranscriber(input: {
  readonly bridge: DesktopVoiceInputBridge;
  readonly readRecording: (uri: string) => CapturedRecording | null;
  /** Read once per recording, when it starts. */
  readonly readRequestOptions: () => DesktopVoiceRequestOptions;
  readonly onFailure: (reason: DesktopVoiceTranscriptionFailureReason) => void;
  readonly onTranscript: (text: string) => void;
}): VoiceTranscriber {
  return {
    prepare: async ({ signal }) => {
      const status = await settleOnAbort(input.bridge.getStatus(), signal);
      if (!status.apiKeyConfigured) {
        input.onFailure("missing-key");
        throw new VoiceTranscriptionError("unavailable", "No ElevenLabs API key is stored.");
      }
      const options = input.readRequestOptions();
      return {
        // The controller only spaces English insertions; an unknown language gets none.
        locale: options.languageCode ?? "und",
        transcribe: async (uri, { signal: transcriptionSignal }) => {
          const recording = input.readRecording(uri);
          if (!recording) {
            throw new VoiceTranscriptionError("transcription-failed", "The recording is missing.");
          }
          const audio = new Uint8Array(await recording.blob.arrayBuffer());
          throwIfVoiceTranscriptionAborted(transcriptionSignal);
          const result = await settleOnAbort(
            input.bridge.transcribe({
              audio,
              mimeType: recording.mimeType,
              languageCode: options.languageCode,
              keyterms: options.keyterms,
            }),
            transcriptionSignal,
          );
          if (result._tag === "failed") {
            input.onFailure(result.reason);
            throw new VoiceTranscriptionError(
              "transcription-failed",
              `ElevenLabs transcription failed: ${result.reason}.`,
            );
          }
          input.onTranscript(result.text);
          return result.text;
        },
      };
    },
  };
}
