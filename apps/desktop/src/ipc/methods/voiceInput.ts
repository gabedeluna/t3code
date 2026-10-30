import {
  DesktopVoiceInputStatus,
  type DesktopVoiceStreamEvent,
  DesktopVoiceStreamOptions,
  DesktopVoiceTranscriptionRequest,
  DesktopVoiceTranscriptionResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElevenLabsClient from "../../voiceInput/ElevenLabsClient.ts";
import * as ElevenLabsKeyStore from "../../voiceInput/ElevenLabsKeyStore.ts";
import * as ElevenLabsRealtime from "../../voiceInput/ElevenLabsRealtime.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const MAX_API_KEY_LENGTH = 512;

// What the renderer posts on a stream's port; see `openStream` in preload.ts.
const StreamPortMessage = Schema.Union([
  Schema.TaggedStruct("audio", {
    pcm: Schema.Union([Schema.instanceOf(ArrayBuffer), Schema.Uint8Array]),
  }),
  Schema.TaggedStruct("finish", {}),
]);
const decodeStreamPortMessage = Schema.decodeUnknownOption(StreamPortMessage);
const decodeStreamOptions = Schema.decodeUnknownOption(DesktopVoiceStreamOptions);

const readApiKey = Effect.gen(function* () {
  const store = yield* ElevenLabsKeyStore.ElevenLabsKeyStore;
  return yield* store.get.pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not read the stored ElevenLabs key.", { error }).pipe(
        Effect.as(Option.none<string>()),
      ),
    ),
  );
});

export const getStatus = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_INPUT_GET_STATUS_CHANNEL,
  payload: Schema.Void,
  result: DesktopVoiceInputStatus,
  handler: Effect.fn("desktop.ipc.voiceInput.getStatus")(function* () {
    return yield* (yield* ElevenLabsKeyStore.ElevenLabsKeyStore).status;
  }),
});

export const setApiKey = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_INPUT_SET_API_KEY_CHANNEL,
  payload: Schema.String.check(Schema.isMaxLength(MAX_API_KEY_LENGTH)),
  result: DesktopVoiceInputStatus,
  handler: Effect.fn("desktop.ipc.voiceInput.setApiKey")(function* (apiKey) {
    const store = yield* ElevenLabsKeyStore.ElevenLabsKeyStore;
    yield* store.set(apiKey);
    return yield* store.status;
  }),
});

export const transcribe = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.VOICE_INPUT_TRANSCRIBE_CHANNEL,
  payload: DesktopVoiceTranscriptionRequest,
  result: DesktopVoiceTranscriptionResult,
  handler: Effect.fn("desktop.ipc.voiceInput.transcribe")(function* (request) {
    const client = yield* ElevenLabsClient.ElevenLabsClient;
    const apiKey = yield* readApiKey;
    if (Option.isNone(apiKey)) {
      return { _tag: "failed", reason: "missing-key" } as const;
    }
    return yield* client.transcribe(apiKey.value, request).pipe(
      Effect.map((text) => ({ _tag: "transcribed", text }) as const),
      Effect.catch((error) => Effect.succeed({ _tag: "failed", reason: error.reason } as const)),
    );
  }),
});

/**
 * A Scribe v2 Realtime stream for one dictation. The renderer posts audio and `finish` on the
 * port and gets stream events back; closing the port from either side drops the stream.
 */
export const openStream: DesktopIpc.DesktopPortIpcMethod<
  never,
  ElevenLabsKeyStore.ElevenLabsKeyStore | ElevenLabsRealtime.ElevenLabsRealtime
> = {
  channel: IpcChannels.VOICE_INPUT_OPEN_STREAM_CHANNEL,
  handler: Effect.fn("desktop.ipc.voiceInput.openStream")(function* (raw, port) {
    const realtime = yield* ElevenLabsRealtime.ElevenLabsRealtime;
    let closed = false;
    const post = (event: DesktopVoiceStreamEvent) => {
      if (closed) return;
      port.postMessage(event);
      if (event._tag === "finished" || event._tag === "failed") {
        closed = true;
        port.close();
      }
    };
    const options = decodeStreamOptions(raw);
    const apiKey = Option.isSome(options) ? yield* readApiKey : Option.none<string>();
    if (Option.isNone(options) || Option.isNone(apiKey)) {
      post({ _tag: "failed", reason: Option.isNone(options) ? "rejected" : "missing-key" });
      return;
    }
    const stream = realtime.open(apiKey.value, options.value, post);
    // Messages queue on the port until it starts, so audio sent while the key was read waits.
    port.on("message", ({ data }) => {
      const message = Option.getOrUndefined(decodeStreamPortMessage(data));
      if (message?._tag === "audio") stream.sendAudio(new Uint8Array(message.pcm));
      else if (message?._tag === "finish") stream.finish();
    });
    port.on("close", () => {
      closed = true;
      stream.close();
    });
    port.start();
  }),
};
