import type { DesktopVoiceStreamEvent } from "@t3tools/contracts";
import { afterEach, assert, beforeEach, describe, it, vi } from "vite-plus/test";

import {
  openRealtimeStream,
  type RealtimeSocketHandlers,
  realtimeUrl,
} from "./ElevenLabsRealtime.ts";

function fakeElevenLabs() {
  const sent: Array<Record<string, unknown>> = [];
  const events: DesktopVoiceStreamEvent[] = [];
  const connection: {
    url: string | null;
    apiKey: string | null;
    handlers: RealtimeSocketHandlers | null;
    closed: boolean;
  } = { url: null, apiKey: null, handlers: null, closed: false };
  const stream = openRealtimeStream({
    apiKey: "sk_test",
    options: { languageCode: "en", keyterms: ["T3 Code"] },
    onEvent: (event) => events.push(event),
    openSocket: (url, apiKey, handlers) => {
      Object.assign(connection, { url, apiKey, handlers });
      return {
        send: (data) => sent.push(JSON.parse(data) as Record<string, unknown>),
        close: () => {
          connection.closed = true;
        },
      };
    },
  });
  const server = {
    open: () => connection.handlers!.onOpen(),
    say: (message: Record<string, unknown>) =>
      connection.handlers!.onMessage(JSON.stringify(message)),
    drop: () => connection.handlers!.onClose(),
  };
  return { stream, server, sent, events, connection };
}

describe("ElevenLabsRealtime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for 16 kHz PCM with phrase commits, the language and each keyterm", () => {
    const url = new URL(realtimeUrl({ languageCode: "en", keyterms: ["T3 Code", "Telify"] }));
    assert.strictEqual(
      url.origin + url.pathname,
      "wss://api.elevenlabs.io/v1/speech-to-text/realtime",
    );
    assert.strictEqual(url.searchParams.get("model_id"), "scribe_v2_realtime");
    assert.strictEqual(url.searchParams.get("audio_format"), "pcm_16000");
    assert.strictEqual(url.searchParams.get("commit_strategy"), "vad");
    assert.strictEqual(url.searchParams.get("language_code"), "en");
    assert.deepStrictEqual(url.searchParams.getAll("keyterms"), ["T3 Code", "Telify"]);
    assert.isFalse(
      new URL(realtimeUrl({ languageCode: null, keyterms: [] })).searchParams.has("language_code"),
    );
  });

  it("queues audio until the socket opens, forwards transcripts, and finishes on the last commit", () => {
    const { stream, server, sent, events, connection } = fakeElevenLabs();
    assert.strictEqual(connection.apiKey, "sk_test");
    assert.notInclude(connection.url!, "sk_test");

    stream.sendAudio(new Uint8Array([1, 2]));
    assert.lengthOf(sent, 0);
    server.open();
    stream.sendAudio(new Uint8Array([3]));
    assert.deepStrictEqual(
      sent.map((message) => [message.audio_base_64, message.commit, message.sample_rate]),
      [
        ["AQI=", false, 16_000],
        ["Aw==", false, 16_000],
      ],
    );

    server.say({ message_type: "session_started", session_id: "s", config: {} });
    server.say({ message_type: "partial_transcript", text: "ship" });
    server.say({ message_type: "partial_transcript", text: "ship it" });
    server.say({ message_type: "committed_transcript", text: "Ship it." });
    server.say({ message_type: "partial_transcript", text: "then" });
    stream.finish();
    assert.deepStrictEqual(sent.at(-1), {
      message_type: "input_audio_chunk",
      audio_base_64: "",
      commit: true,
      sample_rate: 16_000,
    });
    stream.sendAudio(new Uint8Array([4]));
    server.say({ message_type: "committed_transcript", text: "Then merge." });

    assert.deepStrictEqual(events, [
      { _tag: "partial", text: "ship" },
      { _tag: "partial", text: "ship it" },
      { _tag: "committed", text: "Ship it." },
      { _tag: "partial", text: "then" },
      { _tag: "committed", text: "Then merge." },
      { _tag: "finished" },
    ]);
    assert.lengthOf(sent, 3);
    assert.isTrue(connection.closed);
  });

  it("fails once on an ElevenLabs error, a dropped socket or a connection that never opens", () => {
    const rejected = fakeElevenLabs();
    rejected.server.open();
    rejected.server.say({ message_type: "auth_error", error: "Invalid API key" });
    rejected.server.drop();
    assert.deepStrictEqual(rejected.events, [{ _tag: "failed", reason: "invalid-key" }]);
    assert.isTrue(rejected.connection.closed);

    const dropped = fakeElevenLabs();
    dropped.server.open();
    dropped.server.say({ message_type: "partial_transcript", text: "lost" });
    dropped.server.drop();
    assert.deepStrictEqual(dropped.events.at(-1), { _tag: "failed", reason: "unreachable" });

    const stalled = fakeElevenLabs();
    vi.advanceTimersByTime(5_000);
    assert.deepStrictEqual(stalled.events, [{ _tag: "failed", reason: "unreachable" }]);
  });

  it("finishes when the final commit has nothing left to say, and fails when a phrase is stuck", () => {
    const quiet = fakeElevenLabs();
    quiet.server.open();
    quiet.server.say({ message_type: "committed_transcript", text: "Done." });
    quiet.stream.finish();
    vi.advanceTimersByTime(4_000);
    assert.deepStrictEqual(quiet.events.at(-1), { _tag: "finished" });

    const silent = fakeElevenLabs();
    silent.server.open();
    silent.stream.finish();
    silent.server.say({ message_type: "insufficient_audio_activity", error: "No speech" });
    assert.deepStrictEqual(silent.events, [{ _tag: "finished" }]);

    const stuck = fakeElevenLabs();
    stuck.server.open();
    stuck.server.say({ message_type: "partial_transcript", text: "half a" });
    stuck.stream.finish();
    vi.advanceTimersByTime(4_000);
    assert.deepStrictEqual(stuck.events.at(-1), { _tag: "failed", reason: "unreachable" });
  });
});
