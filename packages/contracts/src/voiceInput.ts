import * as Schema from "effect/Schema";

// Desktop dictation through ElevenLabs Scribe. The API key never leaves the desktop main
// process: the renderer sends audio and the request options, and gets text back.

/** Above 100 keyterms ElevenLabs bills every request as at least 20 seconds of audio. */
export const VOICE_INPUT_MAX_KEYTERMS = 100;
/** ElevenLabs takes keyterms under 50 characters of at most five words. */
export const VOICE_INPUT_MAX_KEYTERM_LENGTH = 49;
export const VOICE_INPUT_MAX_KEYTERM_WORDS = 5;
/** Scribe v2 Realtime takes at most 50 keyterms of at most 20 characters. */
export const VOICE_INPUT_MAX_REALTIME_KEYTERMS = 50;
export const VOICE_INPUT_MAX_REALTIME_KEYTERM_LENGTH = 20;
/** The realtime stream is mono 16-bit PCM at this rate. */
export const VOICE_INPUT_STREAM_SAMPLE_RATE = 16_000;

export const VoiceInputKeyterm = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(VOICE_INPUT_MAX_KEYTERM_LENGTH),
);

/** An ISO-639-1 code, or "auto" to let ElevenLabs detect the language. */
export const VoiceInputLanguage = Schema.String.check(Schema.isMaxLength(8));
export const DEFAULT_VOICE_INPUT_LANGUAGE = "en";

/** A `KeyboardEvent.code` held to talk while T3 Code is focused. */
export const VoiceInputHoldKey = Schema.String.check(Schema.isMaxLength(32));
export const DEFAULT_VOICE_INPUT_HOLD_KEY = "ControlRight";

/** Streaming shows words while they are spoken; batch transcribes once recording stops. */
export const VoiceInputMode = Schema.Literals(["streaming", "batch"]);
export type VoiceInputMode = typeof VoiceInputMode.Type;
export const DEFAULT_VOICE_INPUT_MODE: VoiceInputMode = "streaming";

export const DesktopVoiceInputStatus = Schema.Struct({
  apiKeyConfigured: Schema.Boolean,
  /** False when the OS keychain is unavailable, so no key can be stored. */
  encryptionAvailable: Schema.Boolean,
});
export type DesktopVoiceInputStatus = typeof DesktopVoiceInputStatus.Type;

export const DesktopVoiceTranscriptionRequest = Schema.Struct({
  audio: Schema.Uint8Array,
  mimeType: Schema.String.check(Schema.isTrimmed(), Schema.isNonEmpty(), Schema.isMaxLength(128)),
  /** Null lets ElevenLabs detect the language. */
  languageCode: Schema.NullOr(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8))),
  keyterms: Schema.Array(VoiceInputKeyterm).check(Schema.isMaxLength(VOICE_INPUT_MAX_KEYTERMS)),
});
export type DesktopVoiceTranscriptionRequest = typeof DesktopVoiceTranscriptionRequest.Type;

export const DesktopVoiceTranscriptionFailureReason = Schema.Literals([
  "missing-key",
  "invalid-key",
  "quota-exceeded",
  "rate-limited",
  "rejected",
  "unreachable",
  "failed",
]);
export type DesktopVoiceTranscriptionFailureReason =
  typeof DesktopVoiceTranscriptionFailureReason.Type;

export const DesktopVoiceTranscriptionResult = Schema.Union([
  Schema.TaggedStruct("transcribed", { text: Schema.String }),
  Schema.TaggedStruct("failed", { reason: DesktopVoiceTranscriptionFailureReason }),
]);
export type DesktopVoiceTranscriptionResult = typeof DesktopVoiceTranscriptionResult.Type;

export const DesktopVoiceStreamOptions = Schema.Struct({
  /** Null lets ElevenLabs detect the language. */
  languageCode: Schema.NullOr(Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(8))),
  keyterms: Schema.Array(
    VoiceInputKeyterm.check(Schema.isMaxLength(VOICE_INPUT_MAX_REALTIME_KEYTERM_LENGTH)),
  ).check(Schema.isMaxLength(VOICE_INPUT_MAX_REALTIME_KEYTERMS)),
});
export type DesktopVoiceStreamOptions = typeof DesktopVoiceStreamOptions.Type;

/**
 * What the main process reports about one realtime stream. `partial` is the whole phrase
 * Scribe has not committed yet and replaces the previous one; `committed` is final text.
 * `finished` follows the last commit after `finish`; `failed` ends the stream early.
 */
export type DesktopVoiceStreamEvent =
  | { readonly _tag: "partial"; readonly text: string }
  | { readonly _tag: "committed"; readonly text: string }
  | { readonly _tag: "finished" }
  | { readonly _tag: "failed"; readonly reason: DesktopVoiceTranscriptionFailureReason };

/** One realtime stream, open until `finish` settles it or `close` drops it. */
export interface DesktopVoiceStream {
  /** Mono 16-bit little-endian PCM at {@link VOICE_INPUT_STREAM_SAMPLE_RATE}. */
  readonly sendAudio: (pcm: ArrayBuffer) => void;
  /** Commits the last phrase; `finished` or `failed` follows. */
  readonly finish: () => void;
  readonly close: () => void;
}
