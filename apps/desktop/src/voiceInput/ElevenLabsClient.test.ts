import { assert, describe, it } from "@effect/vitest";
import type { DesktopVoiceTranscriptionRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";

import * as ElevenLabsClient from "./ElevenLabsClient.ts";

const request: DesktopVoiceTranscriptionRequest = {
  audio: new Uint8Array([1, 2, 3]),
  mimeType: "audio/webm;codecs=opus",
  languageCode: "en",
  keyterms: ["T3 Code", "Telify"],
};

function respond(status: number, body: unknown) {
  return (request: HttpClientRequest.HttpClientRequest) =>
    HttpClientResponse.fromWeb(
      request,
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
}

/** Answers each request with the next response, repeating the last one. */
const withResponses = <A, E>(
  responses: ReadonlyArray<(request: HttpClientRequest.HttpClientRequest) => Response | unknown>,
  run: (
    sent: Ref.Ref<ReadonlyArray<HttpClientRequest.HttpClientRequest>>,
  ) => Effect.Effect<A, E, ElevenLabsClient.ElevenLabsClient>,
) =>
  Effect.gen(function* () {
    const sent = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([]);
    const layerHttpClient = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((outgoing) =>
        Ref.modify(sent, (previous) => [previous.length, [...previous, outgoing]] as const).pipe(
          Effect.map(
            (index) =>
              responses[Math.min(index, responses.length - 1)]!(
                outgoing,
              ) as HttpClientResponse.HttpClientResponse,
          ),
        ),
      ),
    );
    return yield* run(sent).pipe(
      Effect.provide(ElevenLabsClient.layer.pipe(Layer.provide(layerHttpClient))),
    );
  });

/** Parses the multipart body back the way a server would. */
const sentForm = (outgoing: HttpClientRequest.HttpClientRequest | undefined) =>
  Effect.promise(() => {
    if (outgoing?.body._tag !== "Uint8Array") throw new Error("expected a byte body");
    return new Request("https://api.elevenlabs.io/", {
      method: "POST",
      headers: { "content-type": outgoing.body.contentType },
      body: outgoing.body.body as Uint8Array<ArrayBuffer>,
    }).formData();
  });

const transcribe = (input: DesktopVoiceTranscriptionRequest = request) =>
  Effect.gen(function* () {
    const client = yield* ElevenLabsClient.ElevenLabsClient;
    return yield* client.transcribe("sk_test", input);
  });

describe("ElevenLabsClient", () => {
  it.effect("sends the audio to Scribe v2 with the dictation options and returns the text", () =>
    withResponses([respond(200, { text: "Hello there.", language_code: "eng" })], (sent) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* transcribe(), "Hello there.");

        const [outgoing] = yield* Ref.get(sent);
        assert.strictEqual(outgoing?.method, "POST");
        assert.strictEqual(outgoing?.url, "https://api.elevenlabs.io/v1/speech-to-text");
        assert.strictEqual(outgoing?.headers["xi-api-key"], "sk_test");
        const form = yield* sentForm(outgoing);
        assert.strictEqual(form.get("model_id"), "scribe_v2");
        assert.strictEqual(form.get("language_code"), "en");
        assert.strictEqual(form.get("no_verbatim"), "true");
        assert.strictEqual(form.get("tag_audio_events"), "false");
        assert.deepStrictEqual(form.getAll("keyterms"), ["T3 Code", "Telify"]);
        const file = form.get("file");
        if (!(file instanceof File)) return assert.fail("expected an audio file");
        assert.strictEqual(file.name, "dictation.webm");
        assert.strictEqual(file.type, "audio/webm;codecs=opus");
        assert.deepStrictEqual(
          [...new Uint8Array(yield* Effect.promise(() => file.arrayBuffer()))],
          [1, 2, 3],
        );
      }),
    ),
  );

  it.effect("leaves the language out so ElevenLabs detects it", () =>
    withResponses([respond(200, { text: "Hola." })], (sent) =>
      Effect.gen(function* () {
        yield* transcribe({ ...request, languageCode: null, keyterms: [] });
        const [outgoing] = yield* Ref.get(sent);
        const form = yield* sentForm(outgoing);
        assert.isFalse(form.has("language_code"));
        assert.isFalse(form.has("keyterms"));
      }),
    ),
  );

  it.effect("names why ElevenLabs refused, without retrying a refusal", () =>
    Effect.gen(function* () {
      const cases = [
        [401, { detail: { status: "invalid_api_key", message: "Invalid API key" } }, "invalid-key"],
        [
          401,
          { detail: { status: "quota_exceeded", message: "Out of credits" } },
          "quota-exceeded",
        ],
        [
          422,
          { detail: [{ loc: ["body", "file"], msg: "too short", type: "value_error" }] },
          "rejected",
        ],
      ] as const;
      for (const [status, body, reason] of cases) {
        yield* withResponses([respond(status, body)], (sent) =>
          Effect.gen(function* () {
            const error = yield* Effect.flip(transcribe());
            assert.strictEqual(error.reason, reason);
            assert.strictEqual(error.status, status);
            assert.strictEqual((yield* Ref.get(sent)).length, 1);
          }),
        );
      }
    }),
  );

  it.effect("retries a busy or failing service once", () =>
    withResponses(
      [respond(503, { detail: { status: "system_busy" } }), respond(200, { text: "Second try." })],
      (sent) =>
        Effect.gen(function* () {
          const fiber = yield* Effect.forkChild(transcribe());
          yield* TestClock.adjust("1 second");
          assert.strictEqual(yield* Fiber.join(fiber), "Second try.");
          assert.strictEqual((yield* Ref.get(sent)).length, 2);
        }),
    ),
  );

  it.effect("reports rate limiting after the retry also fails", () =>
    withResponses([respond(429, { detail: { status: "too_many_concurrent_requests" } })], (sent) =>
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(Effect.flip(transcribe()));
        yield* TestClock.adjust("1 second");
        assert.strictEqual((yield* Fiber.join(fiber)).reason, "rate-limited");
        assert.strictEqual((yield* Ref.get(sent)).length, 2);
      }),
    ),
  );
});
