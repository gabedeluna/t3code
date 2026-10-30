import {
  VOICE_INPUT_MAX_KEYTERM_LENGTH,
  VOICE_INPUT_MAX_KEYTERM_WORDS,
  VOICE_INPUT_MAX_KEYTERMS,
} from "@t3tools/contracts";

/** Settings warns from here, before project names start falling off the end. */
export const VOICE_KEYTERM_WARNING_THRESHOLD = 90;

// ElevenLabs rejects the whole request when one keyterm has these.
const UNSUPPORTED_KEYTERM_CHARACTERS = /[<>{}[\]\\]/;

function normalizeVoiceKeyterm(value: string): string | null {
  const keyterm = value.trim().replace(/\s+/g, " ");
  if (
    keyterm === "" ||
    keyterm.length > VOICE_INPUT_MAX_KEYTERM_LENGTH ||
    keyterm.split(" ").length > VOICE_INPUT_MAX_KEYTERM_WORDS ||
    UNSUPPORTED_KEYTERM_CHARACTERS.test(keyterm)
  ) {
    return null;
  }
  return keyterm;
}

export interface VoiceKeyterms {
  /** What goes to ElevenLabs: the user's terms first, then project names, at most 100. */
  readonly keyterms: ReadonlyArray<string>;
  readonly customCount: number;
  readonly projectCount: number;
  /** Usable terms past the cap that were left out, which are always project names first. */
  readonly omitted: number;
  /** The user's entries that ElevenLabs would reject. */
  readonly invalid: ReadonlyArray<string>;
}

export function resolveVoiceKeyterms(
  custom: ReadonlyArray<string>,
  projectNames: ReadonlyArray<string>,
): VoiceKeyterms {
  const seen = new Set<string>();
  const keyterms: string[] = [];
  const invalid: string[] = [];
  let customCount = 0;
  let projectCount = 0;
  let omitted = 0;
  const add = (value: string, source: "custom" | "project") => {
    const keyterm = normalizeVoiceKeyterm(value);
    if (keyterm === null) {
      if (source === "custom" && value.trim() !== "") invalid.push(value);
      return;
    }
    const identity = keyterm.toLowerCase();
    if (seen.has(identity)) return;
    seen.add(identity);
    if (keyterms.length >= VOICE_INPUT_MAX_KEYTERMS) {
      omitted += 1;
      return;
    }
    keyterms.push(keyterm);
    if (source === "custom") customCount += 1;
    else projectCount += 1;
  };
  for (const value of custom) add(value, "custom");
  for (const value of projectNames) add(value, "project");
  return { keyterms, customCount, projectCount, omitted, invalid };
}
