import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
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

describe("LedgerPanel", () => {
  it("lays out a busy ledger as the mockup does", async () => {
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
    // Active and review topics start open; the rest are folded to one line.
    const attack = topics.getByRole("button", { name: /Attack slots/ });
    await expect.element(attack).toHaveAttribute("aria-expanded", "true");
    await expect.element(topics.getByText("Six attack slots, two swinging at once")).toBeVisible();
    await expect.element(topics.getByText("2 open")).toBeVisible();
    const skills = topics.getByRole("button", { name: /Skills and XP/ });
    await expect.element(skills).toHaveAttribute("aria-expanded", "false");
    await expect.element(skills.getByText("1 question · 1 to-do · 1 decided")).toBeVisible();
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
    await using screen = await render(panel());
    await userEvent.click(screen.getByRole("button", { name: "All" }));

    const topics = screen.getByRole("region", { name: "Topics" });
    await expect.element(topics.getByText("Measure the 30 and 50 zombie scenes")).toBeVisible();
    await expect.element(topics.getByText("Four attack slots")).toBeVisible();
    await expect.element(topics.getByRole("button", { name: /closed/ })).not.toBeInTheDocument();
    await expect
      .element(screen.getByRole("region", { name: "Done" }).getByText("Old save format"))
      .toBeVisible();
  });

  it("folds a settled thread's done topic and keeps its answered question", async () => {
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
