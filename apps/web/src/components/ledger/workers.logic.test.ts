import { describe, expect, it } from "vite-plus/test";

import { DIRECTOR_WORKERS } from "./workerFixtures";
import {
  workerGroups,
  workerLine,
  workerMeta,
  workersSubtitle,
  workerStateToneClass,
} from "./workers.logic";

const byTitle = (title: string) => DIRECTOR_WORKERS.find((worker) => worker.title === title)!;

describe("workerGroups", () => {
  it("orders the groups needs you, working, quiet, settled, and drops empty ones", () => {
    expect(
      workerGroups(DIRECTOR_WORKERS).map((group) => [group.label, group.workers.length]),
    ).toEqual([
      ["Needs you", 2],
      ["Working", 2],
      ["Quiet", 2],
      ["Settled", 2],
    ]);
    expect(workerGroups([byTitle("Perf 2")]).map((group) => group.label)).toEqual(["Working"]);
  });
});

describe("worker rows", () => {
  it("leads a worker that needs the user with what it needs", () => {
    const stone = byTitle("Stone textures T.2");
    expect(workerLine(stone)).toBe("Approve stone batch 2 (slate, phyllite, chert)?");
    expect(workerMeta(stone)).toBe("Stone textures · Claude recommends: Approve it");
    const tenant = byTitle("Tenant isolation landing");
    expect(workerMeta(tenant)).toBe("Tenant isolation · your check · 1 more for you");
  });

  it("shows a working worker's topic, next step and progress", () => {
    const hits = byTitle("Hit reactions");
    expect(workerLine(hits)).toBe("Grab and trade animations");
    expect(workerMeta(hits)).toBe("Next: Wire the trade bump · 3 of 5 to-dos done");
  });

  it("says so for a worker whose ledger is off", () => {
    const spike = byTitle("Second dev client spike");
    expect(workerLine(spike)).toBe("");
    expect(workerMeta(spike)).toBe("Ledger off");
    expect(workerLine({ ...spike, state: "input", group: "needs-you" })).toBe(
      "Waiting for your answer",
    );
  });

  it("falls back to the runtime when the ledger has nothing to say", () => {
    const base = byTitle("Night moonlight");
    expect(workerLine(base)).toBe("Nothing open");
    expect(workerMeta(base)).toBe("");
    expect(workerLine({ ...base, state: "approval", group: "needs-you" })).toBe(
      "Waiting for your approval",
    );
    expect(
      workerLine({ ...base, state: "failed", group: "needs-you", lastError: "Usage limit" }),
    ).toBe("Usage limit");
  });

  it("colours states with the sidebar's tones", () => {
    expect(workerStateToneClass("input")).toBe("text-question-foreground");
    expect(workerStateToneClass("approval")).toBe("text-warning-foreground");
    expect(workerStateToneClass("working")).toBe("text-info-foreground");
    expect(workerStateToneClass("failed")).toBe("text-destructive-foreground");
  });

  it("counts workers in the subtitle", () => {
    expect(workersSubtitle(1)).toBe("1 worker · from their ledgers");
    expect(workersSubtitle(6)).toBe("6 workers · from their ledgers");
  });
});
