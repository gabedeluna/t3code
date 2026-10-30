import type {
  DesktopVoiceInputStatus,
  DesktopVoiceTranscriptionRequest,
  DesktopVoiceTranscriptionResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ComposerVoiceSession,
  MIN_VOICE_HOLD_MS,
  type ComposerVoiceError,
  type ComposerVoiceTarget,
} from "./composerVoiceSession";
import type { DesktopVoiceInputBridge } from "./desktopVoiceTranscriber";
import type { MicrophoneRecorder } from "./webVoiceRecorder";

class FakeRecorder implements MicrophoneRecorder {
  uri: string | null = null;
  opened = 0;
  closed = 0;
  private recording = false;

  async open() {
    this.opened += 1;
  }
  close() {
    this.closed += 1;
  }
  async prepareToRecordAsync() {}
  record() {
    this.recording = true;
  }
  async stop() {
    if (!this.recording) return;
    this.recording = false;
    this.uri = "fake-recording:1";
  }
  readRecording(uri: string) {
    return uri === this.uri
      ? { blob: new Blob([new Uint8Array([1, 2, 3])]), mimeType: "audio/webm;codecs=opus" }
      : null;
  }
  deleteRecording(uri: string) {
    if (uri === this.uri) this.uri = null;
  }
}

function setup(options: {
  readonly text?: string;
  readonly cursor?: number;
  readonly status?: DesktopVoiceInputStatus;
  readonly respond?: (
    request: DesktopVoiceTranscriptionRequest,
  ) => Promise<DesktopVoiceTranscriptionResult>;
}) {
  const draft = { ownerKey: "thread-1:", text: options.text ?? "", cursor: options.cursor ?? 0 };
  const requests: DesktopVoiceTranscriptionRequest[] = [];
  const errors: ComposerVoiceError[] = [];
  const recorder = new FakeRecorder();
  const bridge: DesktopVoiceInputBridge = {
    getStatus: async () => options.status ?? { apiKeyConfigured: true, encryptionAvailable: true },
    setApiKey: async () => ({ apiKeyConfigured: true, encryptionAvailable: true }),
    transcribe: (request) => {
      requests.push(request);
      return options.respond?.(request) ?? Promise.resolve({ _tag: "transcribed", text: "" });
    },
    openStream: () => {
      throw new Error("Batch dictation does not stream.");
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
  const session = new ComposerVoiceSession({
    bridge,
    readTarget,
    readRequestOptions: () => ({ languageCode: "en", keyterms: ["T3 Code"] }),
    onError: (error) => errors.push(error),
    createRecorder: () => recorder,
  });
  return { session, draft, requests, errors, recorder };
}

const transcribedResult = (text: string): DesktopVoiceTranscriptionResult => ({
  _tag: "transcribed",
  text,
});
const transcribed = (text: string) => async () => transcribedResult(text);

describe("ComposerVoiceSession", () => {
  it("inserts the transcript where dictation started, even if the cursor moved since", async () => {
    const { session, draft, requests, errors } = setup({
      text: "Fix the bug",
      cursor: 3,
      respond: transcribed("really"),
    });

    await session.toggle();
    expect(session.getPhase()).toBe("recording");
    draft.cursor = draft.text.length;
    await session.toggle();

    expect(draft.text).toBe("Fix really the bug");
    expect(session.getPhase()).toBe("idle");
    expect(errors).toEqual([]);
    expect(requests).toMatchObject([
      { mimeType: "audio/webm;codecs=opus", languageCode: "en", keyterms: ["T3 Code"] },
    ]);
  });

  it("transcribes a held key, and drops a tap or a chord without a request", async () => {
    const { session, draft, requests } = setup({ respond: transcribed("Hello") });
    const hold = session.holdTarget(() => "ControlRight");

    await hold.press(1_000);
    await hold.release(1_000 + MIN_VOICE_HOLD_MS);
    expect(draft.text).toBe("Hello");

    await hold.press(5_000);
    await hold.release(5_000 + MIN_VOICE_HOLD_MS - 1);
    await hold.press(9_000);
    expect(session.getPhase()).toBe("recording");
    hold.abort();

    expect(requests).toHaveLength(1);
    expect(draft.text).toBe("Hello");
    expect(session.getPhase()).toBe("idle");
  });

  it("cancels a hold released before the microphone opened", async () => {
    const { session, requests, recorder } = setup({ respond: transcribed("Hello") });
    const hold = session.holdTarget(() => "ControlRight");

    const pressed = hold.press(1_000);
    expect(session.getPhase()).toBe("preparing");
    await hold.release(5_000);
    await pressed;

    expect(session.getPhase()).toBe("idle");
    expect(recorder.closed).toBe(recorder.opened);
    expect(requests).toEqual([]);
  });

  it("points to Settings without opening the microphone when no key is stored", async () => {
    const { session, recorder, errors } = setup({
      status: { apiKeyConfigured: false, encryptionAvailable: true },
    });

    await session.toggle();

    expect(recorder.opened).toBe(0);
    expect(session.getPhase()).toBe("idle");
    expect(errors).toEqual([
      {
        kind: "message",
        message: "Add your ElevenLabs API key in Settings to dictate.",
        tone: "error",
        opensSettings: true,
      },
    ]);
  });

  it("says why ElevenLabs refused, and keeps the draft as it was", async () => {
    const reasons = [
      ["invalid-key", "ElevenLabs rejected the API key. Check it in Settings.", true],
      ["rate-limited", "ElevenLabs is busy. Try again in a moment.", false],
    ] as const;
    for (const [reason, message, opensSettings] of reasons) {
      const { session, draft, errors } = setup({
        text: "Draft",
        cursor: 5,
        respond: async () => ({ _tag: "failed", reason }),
      });
      await session.toggle();
      await session.toggle();
      expect(draft.text).toBe("Draft");
      expect(errors).toEqual([{ kind: "message", message, tone: "error", opensSettings }]);
    }
  });

  it("reports a silent recording as information, not a failure", async () => {
    const { session, errors } = setup({ respond: transcribed("  ") });
    await session.toggle();
    await session.toggle();
    expect(errors).toEqual([
      { kind: "message", message: "No speech was detected.", tone: "info", opensSettings: false },
    ]);
  });

  it("lands the transcript at the cursor when the draft was typed in meanwhile", async () => {
    const requested = Promise.withResolvers<void>();
    const response = Promise.withResolvers<DesktopVoiceTranscriptionResult>();
    const { session, draft, errors } = setup({
      text: "Draft",
      cursor: 5,
      respond: () => {
        requested.resolve();
        return response.promise;
      },
    });

    await session.toggle();
    const stopped = session.toggle();
    await requested.promise;
    draft.text = "Draft, typed";
    draft.cursor = draft.text.length;
    response.resolve(transcribedResult("then ship it"));
    await stopped;

    expect(draft.text).toBe("Draft, typed then ship it");
    expect(errors).toEqual([]);
  });

  it("offers the transcript for copying when the composer moved to another draft", async () => {
    const requested = Promise.withResolvers<void>();
    const response = Promise.withResolvers<DesktopVoiceTranscriptionResult>();
    const { session, draft, errors } = setup({
      text: "Draft",
      respond: () => {
        requested.resolve();
        return response.promise;
      },
    });

    await session.toggle();
    const stopped = session.toggle();
    await requested.promise;
    draft.ownerKey = "thread-2:";
    draft.text = "Another thread";
    response.resolve(transcribedResult("Ship it."));
    await stopped;

    expect(draft.text).toBe("Another thread");
    expect(errors).toEqual([{ kind: "unplaced-transcript", transcript: "Ship it." }]);
  });

  it("drops a transcript cancelled with Esc and can dictate again at once", async () => {
    const requested = Promise.withResolvers<void>();
    const first = Promise.withResolvers<DesktopVoiceTranscriptionResult>();
    const responses = [first.promise, Promise.resolve(transcribedResult("Second"))];
    const { session, draft, errors } = setup({
      respond: () => {
        requested.resolve();
        return responses.shift()!;
      },
    });

    await session.toggle();
    const stopped = session.toggle();
    await requested.promise;
    expect(session.getPhase()).toBe("transcribing");
    session.cancel();
    expect(session.getPhase()).toBe("idle");
    await stopped;

    await session.toggle();
    await session.toggle();
    first.resolve(transcribedResult("First"));

    expect(draft.text).toBe("Second");
    expect(errors).toEqual([]);
  });
});
