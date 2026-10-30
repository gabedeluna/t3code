import type {
  DesktopBridge,
  DesktopVoiceTranscriptionRequest,
  DesktopVoiceTranscriptionResult,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { ComposerVoiceTarget } from "../../voiceInput/composerVoiceSession";
import { ComposerDictationButton } from "./ComposerDictationButton";
import { useComposerVoiceInput } from "./useComposerVoiceInput";

// The real recorder needs a microphone; this one hands back a fixed clip.
vi.mock("../../voiceInput/webVoiceRecorder", () => ({
  WebVoiceRecorder: class {
    uri: string | null = null;
    private recording = false;
    async open() {}
    close() {}
    async prepareToRecordAsync() {}
    record() {
      this.recording = true;
    }
    async stop() {
      if (this.recording) this.uri = "fake-recording:1";
      this.recording = false;
    }
    readRecording(uri: string) {
      return uri === this.uri
        ? { blob: new Blob([new Uint8Array([1])]), mimeType: "audio/webm" }
        : null;
    }
    deleteRecording() {
      this.uri = null;
    }
  },
}));

function installDesktopBridge(result: DesktopVoiceTranscriptionResult) {
  const requests: DesktopVoiceTranscriptionRequest[] = [];
  const voiceInput: DesktopBridge["voiceInput"] = {
    getStatus: async () => ({ apiKeyConfigured: true, encryptionAvailable: true }),
    setApiKey: async () => ({ apiKeyConfigured: true, encryptionAvailable: true }),
    transcribe: async (request) => {
      requests.push(request);
      return result;
    },
  };
  window.desktopBridge = { voiceInput } as DesktopBridge;
  return {
    requests,
    [Symbol.dispose]: () => {
      delete window.desktopBridge;
    },
  };
}

function draftTarget(text: string) {
  const draft = { text, cursor: text.length };
  const readTarget = (): ComposerVoiceTarget => ({
    ownerKey: "thread-1:",
    text: draft.text,
    cursor: draft.cursor,
    insert: (start, end, inserted) => {
      draft.text = draft.text.slice(0, start) + inserted + draft.text.slice(end);
      return true;
    },
  });
  return { draft, readTarget };
}

function Composer(props: { readonly readTarget: () => ComposerVoiceTarget }) {
  const voiceInput = useComposerVoiceInput({ enabled: true, readTarget: props.readTarget });
  return (
    <ComposerDictationButton
      phase={voiceInput.phase}
      shortcutLabel={null}
      holdKeyLabel="Right Ctrl"
      onToggle={voiceInput.toggle}
    />
  );
}

/** A key event `atMs` into the hold, since hold length comes from event timestamps. */
function holdKeyEvent(type: "keydown" | "keyup", atMs: number) {
  const event = new KeyboardEvent(type, { code: "ControlRight", key: "Control", bubbles: true });
  Object.defineProperty(event, "timeStamp", { value: atMs });
  window.dispatchEvent(event);
}

it("dictates into the draft while Right Ctrl is held", async () => {
  using bridge = installDesktopBridge({ _tag: "transcribed", text: "and ship it" });
  const { draft, readTarget } = draftTarget("Fix the bug");
  await using screen = await render(<Composer readTarget={readTarget} />);

  holdKeyEvent("keydown", 1_000);
  await expect.element(screen.getByRole("button", { name: "Stop and transcribe" })).toBeVisible();
  holdKeyEvent("keyup", 3_000);

  await expect.element(screen.getByRole("button", { name: "Dictate" })).toBeVisible();
  expect(draft.text).toBe("Fix the bug and ship it");
  expect(bridge.requests).toMatchObject([{ mimeType: "audio/webm", languageCode: "en" }]);
});

it("Esc cancels a recording started from the mic button, without a request", async () => {
  using bridge = installDesktopBridge({ _tag: "transcribed", text: "unused" });
  const { draft, readTarget } = draftTarget("Draft");
  await using screen = await render(<Composer readTarget={readTarget} />);

  await userEvent.click(screen.getByRole("button", { name: "Dictate" }));
  await expect.element(screen.getByRole("button", { name: "Stop and transcribe" })).toBeVisible();
  await userEvent.keyboard("{Escape}");

  await expect.element(screen.getByRole("button", { name: "Dictate" })).toBeVisible();
  expect(bridge.requests).toEqual([]);
  expect(draft.text).toBe("Draft");
});
