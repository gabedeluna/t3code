import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as ElevenLabsClient from "../../voiceInput/ElevenLabsClient.ts";
import * as ElevenLabsKeyStore from "../../voiceInput/ElevenLabsKeyStore.ts";
import { transcribe } from "./voiceInput.ts";

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
