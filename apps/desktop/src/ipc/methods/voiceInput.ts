import {
  DesktopVoiceInputStatus,
  DesktopVoiceTranscriptionRequest,
  DesktopVoiceTranscriptionResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ElevenLabsClient from "../../voiceInput/ElevenLabsClient.ts";
import * as ElevenLabsKeyStore from "../../voiceInput/ElevenLabsKeyStore.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const MAX_API_KEY_LENGTH = 512;

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
    const store = yield* ElevenLabsKeyStore.ElevenLabsKeyStore;
    const client = yield* ElevenLabsClient.ElevenLabsClient;
    const apiKey = yield* store.get.pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not read the stored ElevenLabs key.", { error }).pipe(
          Effect.as(Option.none<string>()),
        ),
      ),
    );
    if (Option.isNone(apiKey)) {
      return { _tag: "failed", reason: "missing-key" } as const;
    }
    return yield* client.transcribe(apiKey.value, request).pipe(
      Effect.map((text) => ({ _tag: "transcribed", text }) as const),
      Effect.catch((error) => Effect.succeed({ _tag: "failed", reason: error.reason } as const)),
    );
  }),
});
