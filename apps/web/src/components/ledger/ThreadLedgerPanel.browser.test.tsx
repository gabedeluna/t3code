import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { ComposerHandleContext, type ComposerHandleRef } from "../../composerHandleContext";
import { render } from "../../../test/render";
import { BUSY_LEDGER, OFF_LEDGER, SETTLED_LEDGER } from "./ledgerFixtures";
import { LedgerPanel } from "./ThreadLedgerPanel";

const scribe = { turnModel: "haiku", sweepModel: "sonnet", sweepEvery: 8 };

function panel(props: Partial<Parameters<typeof LedgerPanel>[0]> = {}) {
  return (
    <div style={{ width: 440, height: 900, display: "flex", flexDirection: "column" }}>
      <LedgerPanel
        ledger={BUSY_LEDGER}
        title="7 days Director"
        scribe={scribe}
        canTurnOn
        onTurnOn={vi.fn()}
        {...props}
      />
    </div>
  );
}

// The topics a user opens persist in localStorage; a test that opens one starts and ends with none.
function freshStorage() {
  window.localStorage.clear();
  return { [Symbol.dispose]: () => window.localStorage.clear() };
}

describe("LedgerPanel", () => {
  it("shows the task list under the topic it was filed under", async () => {
    await using screen = await render(panel({ ledger: { ...BUSY_LEDGER, liveTopic: "T1" } }));

    await expect
      .element(screen.getByRole("region", { name: "Working now" }))
      .not.toBeInTheDocument();
    const topics = screen.getByRole("region", { name: "Topics" });
    await expect.element(topics.getByText("Working now · 1/3")).toBeVisible();
    await expect.element(topics.getByText("Add slot claims")).toBeVisible();
  });

  it("shows a topic's newest decisions and pages through the older ones", async () => {
    const decisions = Array.from({ length: 15 }, (_, index) => ({
      id: `d${index + 1}`,
      kind: "decision" as const,
      state: "recorded" as const,
      text: `Decision ${index + 1}`,
      turn: index + 1,
    }));
    const ledger = {
      ...BUSY_LEDGER,
      topics: BUSY_LEDGER.topics.map((topic) =>
        topic.name === "Attack slots" ? { ...topic, items: decisions } : topic,
      ),
    };
    using _storage = freshStorage();
    await using screen = await render(panel({ ledger }));
    await screen.getByRole("button", { name: /Attack slots/ }).click();

    await expect.element(screen.getByText("Decision 13")).toBeVisible();
    await expect.element(screen.getByText("Decision 12")).not.toBeInTheDocument();
    await screen.getByRole("button", { name: "Show 10 more (12 older)" }).click();
    await expect.element(screen.getByText("Decision 3", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Show 2 more (2 older)" }).click();
    await expect.element(screen.getByText("Decision 1", { exact: true })).toBeVisible();
    await screen.getByRole("button", { name: "Show fewer" }).click();
    await expect.element(screen.getByText("Decision 12")).not.toBeInTheDocument();
  });

  it("sends the recommendation, but never along with a message in progress", async () => {
    let prompt = "";
    const insertTextAtEnd = vi.fn(() => true);
    const composer = {
      current: {
        insertTextAtEnd,
        focusAtEnd: vi.fn(),
        getSendContext: () => ({ prompt, images: [], files: [] }),
      },
    } as unknown as ComposerHandleRef;
    const onSendPrompt = vi.fn();
    await using screen = await render(
      <ComposerHandleContext value={composer}>{panel({ onSendPrompt })}</ComposerHandleContext>,
    );

    const needs = screen.getByRole("region", { name: "Needs you" });
    const unrecommended = needs.getByRole("listitem").filter({ hasText: "Was OBS" });
    await expect.element(unrecommended.getByRole("button", { name: "Answer" })).toBeVisible();
    await expect
      .element(unrecommended.getByRole("button", { name: "Use recommended" }))
      .not.toBeInTheDocument();

    const recommended = needs.getByRole("listitem").filter({ hasText: "Start milestone 1" });
    await recommended.getByRole("button", { name: "Use recommended" }).click();
    expect(insertTextAtEnd).toHaveBeenLastCalledWith(
      'Ledger question q4: "Start milestone 1 now, or re-time the horde first?"\nMy answer: go with your recommendation ("Re-time the horde first.")',
      { ensureLeadingBoundary: true },
    );
    expect(onSendPrompt).toHaveBeenCalledTimes(1);

    prompt = "Also, rename the branch";
    await recommended.getByRole("button", { name: "Explain" }).click();
    expect(insertTextAtEnd).toHaveBeenCalledTimes(2);
    expect(onSendPrompt).toHaveBeenCalledTimes(1);
  });

  it("keeps the topics the user opened open after it mounts again", async () => {
    using _storage = freshStorage();
    {
      await using screen = await render(panel());
      await screen.getByRole("button", { name: /Skills and XP/ }).click();
    }
    await using screen = await render(panel());
    await expect
      .element(screen.getByRole("button", { name: /Skills and XP/ }))
      .toHaveAttribute("aria-expanded", "true");
    // Active work no longer opens itself.
    await expect
      .element(screen.getByRole("button", { name: /Attack slots/ }))
      .toHaveAttribute("aria-expanded", "false");
  });

  it("lays out a busy ledger as the mockup does", async () => {
    using _storage = freshStorage();
    await using screen = await render(panel());

    await expect.element(screen.getByRole("heading", { name: "7 days Director" })).toBeVisible();
    await expect.element(screen.getByText("Turn 41 · cleaned up at turn 40")).toBeVisible();

    const working = screen.getByRole("region", { name: "Working now" });
    await expect.element(working.getByText("1/3")).toBeVisible();
    await expect.element(working.getByText("Add slot claims")).toBeVisible();

    const needs = screen.getByRole("region", { name: "Needs you" });
    await expect
      .element(needs.getByText("Was OBS or Dying Light running during the demo?"))
      .toBeVisible();
    await expect
      .element(
        needs.getByText("Skills and XP, milestone 1 · Claude recommends: Re-time the horde first."),
      )
      .toBeVisible();
    await expect.element(needs.getByText("Attack slots · your check")).toBeVisible();

    const topics = screen.getByRole("region", { name: "Topics" });
    // Every topic starts folded to one line.
    const attack = topics.getByRole("button", { name: /Attack slots/ });
    await expect.element(attack).toHaveAttribute("aria-expanded", "false");
    const skills = topics.getByRole("button", { name: /Skills and XP/ });
    await expect.element(skills.getByText("1 question · 1 to-do · 1 decided")).toBeVisible();
    await userEvent.click(attack);
    await expect.element(topics.getByText("Six attack slots, two swinging at once")).toBeVisible();
    await expect.element(topics.getByText("2 open")).toBeVisible();
    await expect
      .element(topics.getByText("XP comes from kills and crafting only"))
      .not.toBeInTheDocument();

    // Closed items wait behind their own fold.
    await expect
      .element(topics.getByText("Measure the 30 and 50 zombie scenes"))
      .not.toBeInTheDocument();
    await userEvent.click(topics.getByRole("button", { name: "Show 2 closed" }));
    await expect.element(topics.getByText("Measure the 30 and 50 zombie scenes")).toBeVisible();
    await expect.element(topics.getByText("Turn 38: 14 ms at 50 zombies")).toBeVisible();

    const done = screen.getByRole("region", { name: "Done" });
    await expect.element(done.getByText("Old save format")).not.toBeInTheDocument();
    await userEvent.click(done.getByRole("button", { name: /Done/ }).first());
    await expect.element(done.getByText("Old save format")).toBeVisible();
    await expect.element(done.getByText("Mod loader swap")).toBeVisible();

    await expect
      .element(screen.getByText("Haiku each turn · Sonnet cleanup every 8"))
      .toBeVisible();
    await expect.element(screen.getByText("$0.31 this thread")).toBeVisible();
  });

  it("shows closed items inline and opens Done in the All view", async () => {
    using _storage = freshStorage();
    await using screen = await render(panel());
    await userEvent.click(screen.getByRole("button", { name: "All" }));

    const topics = screen.getByRole("region", { name: "Topics" });
    await userEvent.click(topics.getByRole("button", { name: /Attack slots/ }));
    await expect.element(topics.getByText("Measure the 30 and 50 zombie scenes")).toBeVisible();
    await expect.element(topics.getByText("Four attack slots")).toBeVisible();
    await expect.element(topics.getByRole("button", { name: /closed/ })).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("region", { name: "Done" }).getByText("Old save format"))
      .toBeVisible();
  });

  it("folds a settled thread's done topic and keeps its answered question", async () => {
    using _storage = freshStorage();
    await using screen = await render(panel({ ledger: SETTLED_LEDGER }));

    await expect.element(screen.getByText("Turn 3")).toBeVisible();
    await expect.element(screen.getByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
    await expect.element(screen.getByRole("region", { name: "Topics" })).not.toBeInTheDocument();

    const done = screen.getByRole("region", { name: "Done" });
    await userEvent.click(done.getByRole("button", { name: /Done/ }).first());
    const topic = done.getByRole("button", { name: /Scripts folder cleanup/ });
    await expect.element(topic.getByText("1 closed")).toBeVisible();
    await userEvent.click(topic);
    await userEvent.click(done.getByRole("button", { name: "Show 1 closed" }));
    await expect.element(done.getByText(/Split scripts\/check-tenant-guards.ts/)).toBeVisible();
    await expect
      .element(
        done.getByText(
          "Turn 3: the user said no, don't split check-tenant-guards.ts; leave it as is",
        ),
      )
      .toBeVisible();
    await expect.element(screen.getByText("<$0.01 this thread")).toBeVisible();
  });

  it("says when the scribe is working and when its last call failed", async () => {
    await using screen = await render(
      panel({ ledger: { ...BUSY_LEDGER, scribing: true, lastError: "Model call timed out" } }),
    );
    await expect.element(screen.getByRole("status")).toHaveTextContent("Updating");
    await expect
      .element(screen.getByText("Last update failed: Model call timed out"))
      .toBeVisible();
  });

  it("offers to turn the ledger on while it is off", async () => {
    const onTurnOn = vi.fn();
    await using screen = await render(panel({ ledger: OFF_LEDGER, onTurnOn }));

    await expect.element(screen.getByText("Ledger is off for this thread")).toBeVisible();
    await expect
      .element(screen.getByText("About a cent per turn at API prices. Starts from the next turn."))
      .toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Turn on ledger" }));
    expect(onTurnOn).toHaveBeenCalledOnce();

    await screen.rerender(panel({ ledger: OFF_LEDGER, canTurnOn: false }));
    await expect.element(screen.getByRole("button", { name: "Turn on ledger" })).toBeDisabled();
  });

  it("waits for the first turn once it is on", async () => {
    await using screen = await render(panel({ ledger: { ...OFF_LEDGER, enabled: true } }));
    await expect.element(screen.getByText("Starts from the next turn")).toBeVisible();
    await expect.element(screen.getByText("Nothing recorded yet")).toBeVisible();
    await expect.element(screen.getByText("$0.00 this thread")).toBeVisible();
  });
});
