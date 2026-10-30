import type {
  DesktopVoiceStreamEvent,
  DesktopVoiceStreamOptions,
  DesktopVoiceTranscriptionRequest,
  DesktopVoiceTranscriptionResult,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ComposerDictationPreview } from "../components/composerDictationPreview";
import { ComposerStreamingSession } from "./composerStreamingSession";
import {
  type ComposerVoiceError,
  type ComposerVoiceTarget,
  MIN_VOICE_HOLD_MS,
} from "./composerVoiceSession";
import type { DesktopVoiceInputBridge } from "./desktopVoiceTranscriber";

// A second of 16 kHz audio, enough for the batch fallback to send.
const SECOND_OF_AUDIO = new Int16Array(16_000);

function setup(options: {
  readonly text?: string;
  readonly cursor?: number;
  readonly respond?: (
    request: DesktopVoiceTranscriptionRequest,
  ) => Promise<DesktopVoiceTranscriptionResult>;
}) {
  const draft = { ownerKey: "thread-1:", text: options.text ?? "", cursor: options.cursor ?? 0 };
  const requests: DesktopVoiceTranscriptionRequest[] = [];
  const errors: ComposerVoiceError[] = [];
  const previews: Array<ComposerDictationPreview | null> = [];
  const stream = {
    options: null as DesktopVoiceStreamOptions | null,
    emit: (_event: DesktopVoiceStreamEvent) => {},
    sent: 0,
    finished: 0,
    closed: 0,
  };
  const microphone = {
    onChunk: (_pcm: Int16Array) => {},
    open: false,
  };
  const bridge: DesktopVoiceInputBridge = {
    getStatus: async () => ({ apiKeyConfigured: true, encryptionAvailable: true }),
    setApiKey: async () => ({ apiKeyConfigured: true, encryptionAvailable: true }),
    transcribe: (request) => {
      requests.push(request);
      return options.respond?.(request) ?? Promise.resolve({ _tag: "transcribed", text: "" });
    },
    openStream: (streamOptions, onEvent) => {
      stream.options = streamOptions;
      stream.emit = onEvent;
      return {
        sendAudio: () => {
          stream.sent += 1;
        },
        finish: () => {
          stream.finished += 1;
        },
        close: () => {
          stream.closed += 1;
        },
      };
    },
  };
  const readTarget = (): ComposerVoiceTarget => ({
    ownerKey: draft.ownerKey,
    text: draft.text,
    cursor: draft.cursor,
    insert: (start, end, text) => {
      draft.text = draft.text.slice(0, start) + text + draft.text.slice(end);
      draft.cursor = start + text.length;
      return true;
    },
  });
  const session = new ComposerStreamingSession({
    bridge,
    readTarget,
    readRequestOptions: () => ({
      languageCode: "en",
      keyterms: ["T3 Code", "a much longer project name"],
      realtimeKeyterms: ["T3 Code"],
    }),
    showPreview: (preview) => previews.push(preview),
    onError: (error) => errors.push(error),
    openCapture: async ({ onChunk }) => {
      microphone.onChunk = onChunk;
      microphone.open = true;
      return {
        stop: async () => {
          microphone.open = false;
        },
        close: () => {
          microphone.open = false;
        },
      };
    },
  });
  return { session, draft, requests, errors, previews, stream, microphone };
}

describe("ComposerStreamingSession", () => {
  it("shows the phrase being heard faded, places each committed phrase, and never sends", async () => {
    const { session, draft, stream, microphone, previews, requests, errors } = setup({
      text: "Fix the bug",
      cursor: 11,
    });

    await session.toggle();
    expect(session.getPhase()).toBe("recording");
    expect(stream.options).toEqual({ languageCode: "en", keyterms: ["T3 Code"] });
    microphone.onChunk(SECOND_OF_AUDIO);
    expect(stream.sent).toBe(1);

    stream.emit({ _tag: "partial", text: "and ship" });
    expect(previews.at(-1)).toEqual({ at: 11, text: " and ship" });
    expect(draft.text).toBe("Fix the bug");

    stream.emit({ _tag: "committed", text: "and ship it." });
    expect(draft.text).toBe("Fix the bug and ship it.");
    expect(previews.at(-1)).toBeNull();
    stream.emit({ _tag: "partial", text: "Then" });
    expect(previews.at(-1)).toEqual({ at: 24, text: " Then" });

    await session.toggle();
    expect(session.getPhase()).toBe("transcribing");
    expect(microphone.open).toBe(false);
    expect(stream.finished).toBe(1);
    stream.emit({ _tag: "committed", text: "Then merge." });
    stream.emit({ _tag: "finished" });

    expect(draft.text).toBe("Fix the bug and ship it. Then merge.");
    expect(session.getPhase()).toBe("idle");
    expect(previews.at(-1)).toBeNull();
    expect(requests).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("finishes a dropped stream through batch, replacing the live text with the full transcript", async () => {
    const { session, draft, stream, microphone, requests, errors } = setup({
      text: "Note:",
      cursor: 5,
      respond: async () => ({ _tag: "transcribed", text: "ship it then merge" }),
    });

    await session.toggle();
    microphone.onChunk(SECOND_OF_AUDIO);
    stream.emit({ _tag: "committed", text: "ship it" });
    stream.emit({ _tag: "failed", reason: "unreachable" });
    expect(session.getPhase()).toBe("recording");
    microphone.onChunk(SECOND_OF_AUDIO);
    expect(stream.sent).toBe(1);

    await session.toggle();

    expect(requests).toMatchObject([
      {
        mimeType: "audio/wav",
        languageCode: "en",
        keyterms: ["T3 Code", "a much longer project name"],
      },
    ]);
    // A 44-byte header and two seconds of 16-bit samples.
    expect(requests[0]!.audio.byteLength).toBe(44 + 2 * 2 * 16_000);
    expect(draft.text).toBe("Note: ship it then merge");
    expect(session.getPhase()).toBe("idle");
    expect(errors).toEqual([]);
  });

  it("falls back when the stream fails while the last phrase is being committed", async () => {
    const { session, draft, stream, microphone, requests } = setup({
      respond: async () => ({ _tag: "transcribed", text: "Hello there." }),
    });

    await session.toggle();
    microphone.onChunk(SECOND_OF_AUDIO);
    stream.emit({ _tag: "partial", text: "Hello" });
    await session.toggle();
    stream.emit({ _tag: "failed", reason: "unreachable" });
    await vi.waitFor(() => expect(draft.text).toBe("Hello there."));
    expect(requests).toHaveLength(1);
  });

  it("falls back when the stream never answers the stop", async () => {
    vi.useFakeTimers();
    try {
      const { session, draft, stream, microphone, requests, errors } = setup({
        respond: async () => ({ _tag: "transcribed", text: "Hello there." }),
      });

      await session.toggle();
      microphone.onChunk(SECOND_OF_AUDIO);
      await session.toggle();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(session.getPhase()).toBe("transcribing");

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => expect(session.getPhase()).toBe("idle"));
      expect(stream.closed).toBe(1);
      expect(requests).toHaveLength(1);
      expect(draft.text).toBe("Hello there.");
      expect(errors).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops at once on a key problem, which batch would hit too", async () => {
    const { session, stream, microphone, requests, errors } = setup({});

    await session.toggle();
    microphone.onChunk(SECOND_OF_AUDIO);
    stream.emit({ _tag: "failed", reason: "invalid-key" });

    expect(session.getPhase()).toBe("idle");
    expect(microphone.open).toBe(false);
    expect(requests).toEqual([]);
    expect(errors).toMatchObject([{ kind: "message", opensSettings: true }]);
  });

  it("Esc takes back the dictated text, and a tap is cancelled without keeping any", async () => {
    const { session, draft, stream, microphone } = setup({ text: "Draft", cursor: 5 });

    await session.toggle();
    stream.emit({ _tag: "committed", text: "and more" });
    expect(draft.text).toBe("Draft and more");
    session.cancel();
    expect(draft.text).toBe("Draft");
    expect(stream.closed).toBe(1);
    expect(microphone.open).toBe(false);

    const hold = session.holdTarget(() => "ControlRight");
    await hold.press(1_000);
    await hold.release(1_000 + MIN_VOICE_HOLD_MS - 1);
    expect(session.getPhase()).toBe("idle");
    expect(stream.closed).toBe(2);
    expect(stream.finished).toBe(0);
  });

  it("offers phrases for copying once the composer has moved to another draft", async () => {
    const { session, draft, stream, errors } = setup({ text: "One" });

    await session.toggle();
    draft.ownerKey = "thread-2:";
    stream.emit({ _tag: "committed", text: "Lost words." });
    await session.toggle();
    stream.emit({ _tag: "finished" });

    expect(draft.text).toBe("One");
    expect(errors).toEqual([{ kind: "unplaced-transcript", transcript: "Lost words." }]);
  });
});
