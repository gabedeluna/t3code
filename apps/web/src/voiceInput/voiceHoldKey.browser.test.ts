import { describe, expect, it } from "vite-plus/test";

import { registerVoiceHoldTarget, type VoiceHoldTarget } from "./voiceHoldKey";

function recordingTarget(holdKey: string | null = "ControlRight") {
  const events: string[] = [];
  const target: VoiceHoldTarget = {
    holdKey: () => holdKey,
    press: () => {
      events.push("press");
    },
    release: () => {
      events.push("release");
    },
    abort: () => events.push("abort"),
  };
  return { events, target };
}

function key(type: "keydown" | "keyup", code: string, init: KeyboardEventInit = {}) {
  window.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true, ...init }));
}

describe("voice hold key", () => {
  it("presses on the hold key, ignores its repeats, and releases on key-up", () => {
    const { events, target } = recordingTarget();
    using _registration = { [Symbol.dispose]: registerVoiceHoldTarget(target) };

    key("keydown", "ControlRight");
    key("keydown", "ControlRight", { repeat: true });
    key("keyup", "ControlRight");
    key("keydown", "ControlLeft");
    key("keyup", "ControlLeft");

    expect(events).toEqual(["press", "release"]);
  });

  it("aborts when another key joins, as in a Ctrl+C chord", () => {
    const { events, target } = recordingTarget();
    using _registration = { [Symbol.dispose]: registerVoiceHoldTarget(target) };

    key("keydown", "ControlRight");
    key("keydown", "KeyC", { ctrlKey: true });
    key("keyup", "KeyC");
    key("keyup", "ControlRight");

    expect(events).toEqual(["press", "abort"]);
  });

  it("releases when the window loses focus mid-hold", () => {
    const { events, target } = recordingTarget();
    using _registration = { [Symbol.dispose]: registerVoiceHoldTarget(target) };

    key("keydown", "ControlRight");
    window.dispatchEvent(new FocusEvent("blur"));
    key("keyup", "ControlRight");

    expect(events).toEqual(["press", "release"]);
  });

  it("drives only the newest composer, and does nothing with hold-to-talk off", () => {
    const older = recordingTarget();
    const newer = recordingTarget(null);
    using _older = { [Symbol.dispose]: registerVoiceHoldTarget(older.target) };
    {
      using _newer = { [Symbol.dispose]: registerVoiceHoldTarget(newer.target) };
      key("keydown", "ControlRight");
      key("keyup", "ControlRight");
    }
    key("keydown", "ControlRight");
    key("keyup", "ControlRight");

    expect(newer.events).toEqual([]);
    expect(older.events).toEqual(["press", "release"]);
  });
});
