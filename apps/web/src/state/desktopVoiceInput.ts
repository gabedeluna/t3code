import type { DesktopVoiceInputStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Atom } from "effect/reactivity";

import { getDesktopVoiceInputBridge } from "~/voiceInput/desktopVoiceTranscriber";

class DesktopVoiceInputUnavailableError extends Schema.TaggedError<DesktopVoiceInputUnavailableError>()(
  "DesktopVoiceInputUnavailableError",
  {},
) {
  override get message(): string {
    return "Dictation is only available in the desktop app.";
  }
}

class DesktopVoiceInputLoadError extends Schema.TaggedError<DesktopVoiceInputLoadError>()(
  "DesktopVoiceInputLoadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read the dictation settings.";
  }
}

const loadDesktopVoiceInputStatus = Effect.fn("loadDesktopVoiceInputStatus")(function* () {
  const bridge = getDesktopVoiceInputBridge();
  if (!bridge) {
    return yield* new DesktopVoiceInputUnavailableError();
  }
  return yield* Effect.tryPromise({
    try: (): Promise<DesktopVoiceInputStatus> => bridge.getStatus(),
    catch: (cause) => new DesktopVoiceInputLoadError({ cause }),
  });
});

export const desktopVoiceInputStatusAtom = Atom.make(loadDesktopVoiceInputStatus()).pipe(
  Atom.keepAlive,
  Atom.swr({ staleTime: 30_000, revalidateOnMount: true }),
  Atom.withLabel("desktop:voice-input:status"),
);
