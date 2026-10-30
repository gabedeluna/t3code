// @effect-diagnostics globalTimers:off -- Stream deadlines run in socket and port callbacks, outside any Effect fiber.
import {
  type DesktopVoiceStreamEvent,
  type DesktopVoiceStreamOptions,
  type DesktopVoiceTranscriptionFailureReason,
  VOICE_INPUT_STREAM_SAMPLE_RATE,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const REALTIME_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const REALTIME_MODEL = "scribe_v2_realtime";
const CONNECT_TIMEOUT_MS = 5_000;
// The last phrase usually commits within a few hundred milliseconds of the commit request.
const FINISH_TIMEOUT_MS = 4_000;

const RealtimeMessage = Schema.Struct({
  message_type: Schema.String,
  text: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
const decodeRealtimeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(RealtimeMessage));

/** The parts of a WebSocket a realtime stream uses, so tests can stand in for ElevenLabs. */
export interface RealtimeSocket {
  readonly send: (data: string) => void;
  readonly close: () => void;
}

export interface RealtimeSocketHandlers {
  readonly onOpen: () => void;
  readonly onMessage: (data: string) => void;
  readonly onClose: () => void;
}

export type OpenRealtimeSocket = (
  url: string,
  apiKey: string,
  handlers: RealtimeSocketHandlers,
) => RealtimeSocket;

export function realtimeUrl(options: DesktopVoiceStreamOptions): string {
  const url = new URL(REALTIME_URL);
  url.searchParams.set("model_id", REALTIME_MODEL);
  url.searchParams.set("audio_format", `pcm_${VOICE_INPUT_STREAM_SAMPLE_RATE}`);
  // Scribe commits each phrase at a pause, which is what turns faded text solid.
  url.searchParams.set("commit_strategy", "vad");
  url.searchParams.set("no_verbatim", "true");
  if (options.languageCode !== null) url.searchParams.set("language_code", options.languageCode);
  for (const keyterm of options.keyterms) url.searchParams.append("keyterms", keyterm);
  return url.toString();
}

function failureReason(messageType: string): DesktopVoiceTranscriptionFailureReason {
  switch (messageType) {
    case "auth_error":
      return "invalid-key";
    case "quota_exceeded":
      return "quota-exceeded";
    case "rate_limited":
    case "queue_overflow":
    case "resource_exhausted":
      return "rate-limited";
    case "unaccepted_terms":
    case "invalid_request":
    case "input_error":
    case "chunk_size_exceeded":
      return "rejected";
    default:
      return "failed";
  }
}

const IGNORED_MESSAGES = new Set([
  "session_started",
  "committed_transcript_with_timestamps",
  "committed_transcript_entities",
  "edited_transcript",
  "warning",
  // A finishing stream waits on its timeout instead.
  "commit_throttled",
]);

export interface RealtimeStream {
  readonly sendAudio: (pcm: Uint8Array) => void;
  readonly finish: () => void;
  readonly close: () => void;
}

/**
 * One Scribe v2 Realtime session. Audio sent before the socket opens is queued, so nothing
 * spoken while connecting is lost. Exactly one `finished` or `failed` ends the stream.
 */
export function openRealtimeStream(input: {
  readonly openSocket: OpenRealtimeSocket;
  readonly apiKey: string;
  readonly options: DesktopVoiceStreamOptions;
  readonly onEvent: (event: DesktopVoiceStreamEvent) => void;
}): RealtimeStream {
  let open = false;
  let done = false;
  let finishing = false;
  let partial = "";
  const queued: string[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const setTimer = (ms: number, onTimeout: () => void) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(onTimeout, ms);
  };
  const end = (event: DesktopVoiceStreamEvent) => {
    if (done) return;
    done = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    queued.length = 0;
    input.onEvent(event);
    socket.close();
  };
  // Nothing uncommitted means nothing is lost, even when the final commit never answers.
  const endFinishing = () => end(partial === "" ? { _tag: "finished" } : failed("unreachable"));
  const failed = (reason: DesktopVoiceTranscriptionFailureReason): DesktopVoiceStreamEvent => ({
    _tag: "failed",
    reason,
  });
  const send = (message: string) => {
    if (open) socket.send(message);
    else queued.push(message);
  };
  const commitMessage = JSON.stringify({
    message_type: "input_audio_chunk",
    audio_base_64: "",
    commit: true,
    sample_rate: VOICE_INPUT_STREAM_SAMPLE_RATE,
  });

  const handleMessage = (data: string) => {
    if (done) return;
    const message = Option.getOrUndefined(decodeRealtimeMessage(data));
    if (!message || IGNORED_MESSAGES.has(message.message_type)) return;
    switch (message.message_type) {
      case "partial_transcript": {
        const text = message.text ?? "";
        if (text === partial) return;
        partial = text;
        input.onEvent({ _tag: "partial", text });
        return;
      }
      case "committed_transcript": {
        partial = "";
        const text = message.text ?? "";
        if (text.trim() !== "") input.onEvent({ _tag: "committed", text });
        if (finishing) end({ _tag: "finished" });
        return;
      }
      case "insufficient_audio_activity":
        if (finishing) endFinishing();
        return;
      default:
        if (finishing && partial === "") end({ _tag: "finished" });
        else end(failed(failureReason(message.message_type)));
    }
  };

  const socket = input.openSocket(realtimeUrl(input.options), input.apiKey, {
    onOpen: () => {
      if (done) return;
      open = true;
      if (!finishing && timer !== null) clearTimeout(timer);
      for (const message of queued.splice(0)) socket.send(message);
    },
    onMessage: handleMessage,
    onClose: () => {
      if (done) return;
      if (finishing) endFinishing();
      else end(failed("unreachable"));
    },
  });
  setTimer(CONNECT_TIMEOUT_MS, () => {
    if (!open) end(failed("unreachable"));
  });

  return {
    sendAudio: (pcm) => {
      if (done || finishing) return;
      send(
        JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: Buffer.from(pcm).toString("base64"),
          commit: false,
          sample_rate: VOICE_INPUT_STREAM_SAMPLE_RATE,
        }),
      );
    },
    finish: () => {
      if (done || finishing) return;
      finishing = true;
      send(commitMessage);
      setTimer(FINISH_TIMEOUT_MS, endFinishing);
    },
    close: () => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      socket.close();
    },
  };
}

// Node's WebSocket (undici) takes request headers, so the key never goes in the URL. The DOM
// types this package compiles against only know the protocols argument.
const openWebSocket: OpenRealtimeSocket = (url, apiKey, handlers) => {
  const init = { headers: { "xi-api-key": apiKey } };
  const socket = new WebSocket(url, init as unknown as string[]);
  socket.addEventListener("open", handlers.onOpen);
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") handlers.onMessage(event.data);
  });
  socket.addEventListener("close", handlers.onClose);
  return {
    send: (data) => socket.send(data),
    close: () => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
    },
  };
};

export class ElevenLabsRealtime extends Context.Service<
  ElevenLabsRealtime,
  {
    readonly open: (
      apiKey: string,
      options: DesktopVoiceStreamOptions,
      onEvent: (event: DesktopVoiceStreamEvent) => void,
    ) => RealtimeStream;
  }
>()("@t3tools/desktop/voiceInput/ElevenLabsRealtime") {}

export const make = (openSocket: OpenRealtimeSocket) =>
  ElevenLabsRealtime.of({
    open: (apiKey, options, onEvent) =>
      openRealtimeStream({ openSocket, apiKey, options, onEvent }),
  });

export const layer = Layer.succeed(ElevenLabsRealtime, make(openWebSocket));
