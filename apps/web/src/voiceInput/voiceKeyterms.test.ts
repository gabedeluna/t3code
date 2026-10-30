import { describe, expect, it } from "vite-plus/test";

import { resolveVoiceKeyterms } from "./voiceKeyterms";

const projects = (count: number) => Array.from({ length: count }, (_, index) => `project-${index}`);

describe("resolveVoiceKeyterms", () => {
  it("puts the user's terms first, drops duplicates, and caps the list at 100", () => {
    const resolved = resolveVoiceKeyterms(
      ["T3 Code", "  Effect   TS ", "t3 code"],
      ["T3 Code", ...projects(110)],
    );

    expect(resolved.keyterms).toHaveLength(100);
    expect(resolved.keyterms.slice(0, 3)).toEqual(["T3 Code", "Effect TS", "project-0"]);
    expect(resolved).toMatchObject({ customCount: 2, projectCount: 98, omitted: 12, invalid: [] });
  });

  it("leaves out what ElevenLabs would reject, and names the user's own", () => {
    const tooLong = "x".repeat(50);
    const resolved = resolveVoiceKeyterms(
      ["ok", tooLong, "one two three four five six", "a <tag>", "path\\name", "  "],
      ["{braces}", "fine project"],
    );

    expect(resolved.keyterms).toEqual(["ok", "fine project"]);
    expect(resolved.invalid).toEqual([
      tooLong,
      "one two three four five six",
      "a <tag>",
      "path\\name",
    ]);
  });
});
