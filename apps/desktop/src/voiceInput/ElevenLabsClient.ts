import {
  DesktopVoiceTranscriptionFailureReason,
  type DesktopVoiceTranscriptionRequest,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

const SPEECH_TO_TEXT_URL = "https://api.elevenlabs.io/v1/speech-to-text";
const SPEECH_TO_TEXT_MODEL = "scribe_v2";
// Five minutes of audio transcribes in well under this; past it the request is stuck.
const TRANSCRIPTION_TIMEOUT = Duration.seconds(60);
const RETRY_DELAY = Duration.millis(500);

const TranscriptResponse = Schema.Struct({ text: Schema.String });
// 401 bodies say why: `{ detail: { status: "invalid_api_key" | "quota_exceeded", message } }`.
// 422 bodies carry a list of field errors instead, which this leaves undecoded.
const ErrorResponse = Schema.Struct({
  detail: Schema.Struct({
    status: Schema.optional(Schema.String),
    message: Schema.optional(Schema.String),
  }),
});
const decodeErrorResponse = Schema.decodeUnknownOption(ErrorResponse);

export class ElevenLabsTranscriptionError extends Schema.TaggedError<ElevenLabsTranscriptionError>()(
  "ElevenLabsTranscriptionError",
  {
    reason: DesktopVoiceTranscriptionFailureReason,
    status: Schema.optionalKey(Schema.Number),
    // A message, never the HTTP error itself: that carries the request and its xi-api-key header.
    detail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    const status = this.status === undefined ? "" : ` (HTTP ${this.status})`;
    return `ElevenLabs transcription failed: ${this.reason}${status}.`;
  }
}

export class ElevenLabsClient extends Context.Service<
  ElevenLabsClient,
  {
    readonly transcribe: (
      apiKey: string,
      request: DesktopVoiceTranscriptionRequest,
    ) => Effect.Effect<string, ElevenLabsTranscriptionError>;
  }
>()("@t3tools/desktop/voiceInput/ElevenLabsClient") {}

const RECORDING_EXTENSIONS: Readonly<Record<string, string>> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
};

function speechToTextForm(request: DesktopVoiceTranscriptionRequest): FormData {
  const mimeType = request.mimeType.split(";")[0]!.trim();
  const form = new FormData();
  form.append("model_id", SPEECH_TO_TEXT_MODEL);
  form.append(
    "file",
    new Blob([request.audio as Uint8Array<ArrayBuffer>], { type: request.mimeType }),
    `dictation.${RECORDING_EXTENSIONS[mimeType] ?? "webm"}`,
  );
  if (request.languageCode !== null) form.append("language_code", request.languageCode);
  // Dictation wants what was meant: no fillers, false starts, or "(laughs)".
  form.append("no_verbatim", "true");
  form.append("tag_audio_events", "false");
  for (const keyterm of request.keyterms) form.append("keyterms", keyterm);
  return form;
}

// Undici's dispatcher stalls on a FormData body (seen with undici 8), so the form is
// encoded to bytes up front and sent as a plain buffer.
const encodeSpeechToTextBody = (request: DesktopVoiceTranscriptionRequest) =>
  Effect.promise(async () => {
    const encoded = new Response(speechToTextForm(request));
    return {
      contentType: encoded.headers.get("content-type") ?? "multipart/form-data",
      bytes: new Uint8Array(await encoded.arrayBuffer()),
    };
  });

function failureReason(
  status: number,
  detailStatus: string | undefined,
): DesktopVoiceTranscriptionFailureReason {
  if (status === 401) return detailStatus === "quota_exceeded" ? "quota-exceeded" : "invalid-key";
  if (status === 402) return "quota-exceeded";
  if (status === 429) return "rate-limited";
  if (status >= 500) return "failed";
  return "rejected";
}

const readFailure = Effect.fn("desktop.voiceInput.elevenLabs.readFailure")(function* (
  response: HttpClientResponse.HttpClientResponse,
) {
  const body = yield* response.json.pipe(Effect.option);
  const detail = Option.flatMap(body, decodeErrorResponse).pipe(
    Option.map((decoded) => decoded.detail),
    Option.getOrUndefined,
  );
  return yield* new ElevenLabsTranscriptionError({
    reason: failureReason(response.status, detail?.status),
    status: response.status,
    ...(detail?.message === undefined ? {} : { detail: detail.message }),
  });
});

const isTransient = (error: ElevenLabsTranscriptionError) =>
  error.reason === "unreachable" || error.reason === "rate-limited" || error.reason === "failed";

/** @public */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;

  const attempt = (
    apiKey: string,
    body: Effect.Success<ReturnType<typeof encodeSpeechToTextBody>>,
  ) =>
    HttpClientRequest.post(SPEECH_TO_TEXT_URL).pipe(
      HttpClientRequest.setHeader("xi-api-key", apiKey),
      HttpClientRequest.acceptJson,
      HttpClientRequest.bodyUint8Array(body.bytes, body.contentType),
      httpClient.execute,
      Effect.timeout(TRANSCRIPTION_TIMEOUT),
      Effect.mapError(
        (cause) =>
          new ElevenLabsTranscriptionError({ reason: "unreachable", detail: cause.message }),
      ),
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? HttpClientResponse.schemaBodyJson(TranscriptResponse)(response).pipe(
              Effect.map((transcript) => transcript.text),
              Effect.mapError(
                (cause) =>
                  new ElevenLabsTranscriptionError({
                    reason: "failed",
                    status: response.status,
                    detail: cause.message,
                  }),
              ),
            )
          : readFailure(response),
      ),
    );

  return ElevenLabsClient.of({
    transcribe: Effect.fn("desktop.voiceInput.elevenLabs.transcribe")(
      function* (apiKey, request) {
        const body = yield* encodeSpeechToTextBody(request);
        return yield* attempt(apiKey, body).pipe(
          Effect.retry({ times: 1, while: isTransient, schedule: Schedule.spaced(RETRY_DELAY) }),
        );
      },
      Effect.tapError((error) =>
        Effect.logWarning("ElevenLabs transcription failed.", {
          reason: error.reason,
          status: error.status,
          detail: error.detail,
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(ElevenLabsClient, make);
