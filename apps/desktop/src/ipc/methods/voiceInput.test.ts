import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ElevenLabsClient from "../../voiceInput/ElevenLabsClient.ts";
import * as ElevenLabsKeyStore from "../../voiceInput/ElevenLabsKeyStore.ts";
import * as ElevenLabsRealtime from "../../voiceInput/ElevenLabsRealtime.ts";
import type { DesktopIpcPort } from "../DesktopIpc.ts";
import { openStream, transcribe } from "./voiceInput.ts";

const request = {
  audio: new Uint8Array([1, 2, 3]),
  mimeType: "audio/webm",
  languageCode: "en",
  keyterms: [],
};

const withServices = <A, E>(
  storedKey: Option.Option<string>,
  respond: Effect.Effect<string, ElevenLabsClient.ElevenLabsTranscriptionError>,
  run: (
    usedKeys: Ref.Ref<ReadonlyArray<string>>,
  ) => Effect.Effect<
    A,
    E,
    ElevenLabsKeyStore.ElevenLabsKeyStore | ElevenLabsClient.ElevenLabsClient
  >,
) =>
  Effect.gen(function* () {
    const usedKeys = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = Layer.mergeAll(
      Layer.succeed(ElevenLabsKeyStore.ElevenLabsKeyStore, {
        status: Effect.succeed({
          apiKeyConfigured: Option.isSome(storedKey),
          encryptionAvailable: true,
        }),
        get: Effect.succeed(storedKey),
        set: () => Effect.succeed(true),
      }),
      Layer.succeed(ElevenLabsClient.ElevenLabsClient, {
        transcribe: (apiKey) =>
          Ref.update(usedKeys, (keys) => [...keys, apiKey]).pipe(Effect.andThen(respond)),
      }),
    );
    return yield* run(usedKeys).pipe(Effect.provide(layer));
  });

describe("voiceInput.transcribe", () => {
  it.effect("asks for a key without calling ElevenLabs when none is stored", () =>
    withServices(Option.none(), Effect.succeed("unused"), (usedKeys) =>
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* transcribe.handler(request), {
          _tag: "failed",
          reason: "missing-key",
        });
        assert.deepStrictEqual(yield* Ref.get(usedKeys), []);
      }),
    ),
  );

  it.effect("returns the transcript, or why ElevenLabs refused it", () =>
    Effect.gen(function* () {
      yield* withServices(Option.some("sk_live"), Effect.succeed("Ship it."), (usedKeys) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(yield* transcribe.handler(request), {
            _tag: "transcribed",
            text: "Ship it.",
          });
          assert.deepStrictEqual(yield* Ref.get(usedKeys), ["sk_live"]);
        }),
      );
      yield* withServices(
        Option.some("sk_revoked"),
        Effect.fail(
          new ElevenLabsClient.ElevenLabsTranscriptionError({ reason: "invalid-key", status: 401 }),
        ),
        () =>
          Effect.gen(function* () {
            assert.deepStrictEqual(yield* transcribe.handler(request), {
              _tag: "failed",
              reason: "invalid-key",
            });
          }),
      );
    }),
  );
});

function fakePort() {
  const posted: unknown[] = [];
  const listeners: { message?: (message: { data: unknown }) => void; close?: () => void } = {};
  const state = { started: false, closed: false };
  const port: DesktopIpcPort = {
    on: (event: "message" | "close", listener: never) => {
      listeners[event] = listener;
    },
    postMessage: (message) => posted.push(message),
    start: () => {
      state.started = true;
    },
    close: () => {
      state.closed = true;
    },
  };
  return { port, posted, listeners, state };
}

const keyStoreWith = (storedKey: Option.Option<string>) =>
  Layer.succeed(ElevenLabsKeyStore.ElevenLabsKeyStore, {
    status: Effect.succeed({
      apiKeyConfigured: Option.isSome(storedKey),
      encryptionAvailable: true,
    }),
    get: Effect.succeed(storedKey),
    set: () => Effect.succeed(true),
  });

describe("voiceInput.openStream", () => {
  it.effect("reports a missing key on the port and closes it without connecting", () =>
    Effect.gen(function* () {
      const { port, posted, state } = fakePort();
      let opened = 0;
      yield* openStream.handler({ languageCode: "en", keyterms: [] }, port).pipe(
        Effect.provide(
          Layer.mergeAll(
            keyStoreWith(Option.none()),
            Layer.succeed(
              ElevenLabsRealtime.ElevenLabsRealtime,
              ElevenLabsRealtime.make(() => {
                opened += 1;
                return { send: () => undefined, close: () => undefined };
              }),
            ),
          ),
        ),
      );
      assert.deepStrictEqual(posted, [{ _tag: "failed", reason: "missing-key" }]);
      assert.isTrue(state.closed);
      assert.strictEqual(opened, 0);
    }),
  );

  it.effect("streams port audio to ElevenLabs and closes the port after the last commit", () =>
    Effect.gen(function* () {
      const { port, posted, listeners, state } = fakePort();
      const sent: string[] = [];
      let handlers: ElevenLabsRealtime.RealtimeSocketHandlers | null = null;
      yield* openStream.handler({ languageCode: "en", keyterms: [] }, port).pipe(
        Effect.provide(
          Layer.mergeAll(
            keyStoreWith(Option.some("sk_live")),
            Layer.succeed(
              ElevenLabsRealtime.ElevenLabsRealtime,
              ElevenLabsRealtime.make((_url, _apiKey, socketHandlers) => {
                handlers = socketHandlers;
                return { send: (data) => sent.push(data), close: () => undefined };
              }),
            ),
          ),
        ),
      );
      assert.isTrue(state.started);
      handlers!.onOpen();
      listeners.message!({ data: { _tag: "audio", pcm: new Uint8Array([1]).buffer } });
      listeners.message!({ data: { _tag: "finish" } });
      handlers!.onMessage(JSON.stringify({ message_type: "committed_transcript", text: "Hi." }));
      assert.deepStrictEqual(
        sent.map((data) => (JSON.parse(data) as { commit: boolean }).commit),
        [false, true],
      );
      assert.deepStrictEqual(posted, [{ _tag: "committed", text: "Hi." }, { _tag: "finished" }]);
      assert.isTrue(state.closed);
    }),
  );
});
