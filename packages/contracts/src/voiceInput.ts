import * as Schema from "effect/Schema";

// Desktop dictation through ElevenLabs Scribe. The API key never leaves the desktop main
// process: the renderer sends audio and the request options, and gets text back.

/** Above 100 keyterms ElevenLabs bills every request as at least 20 seconds of audio. */
export const VOICE_INPUT_MAX_KEYTERMS = 100;
/** ElevenLabs takes keyterms under 50 characters of at most five words. */
export const VOICE_INPUT_MAX_KEYTERM_LENGTH = 49;
export const VOICE_INPUT_MAX_KEYTERM_WORDS = 5;

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
