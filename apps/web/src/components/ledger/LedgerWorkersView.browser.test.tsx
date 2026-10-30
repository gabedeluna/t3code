import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { useState } from "react";
import "~/index.css";
import { render } from "../../../test/render";
import { BUSY_LEDGER, OFF_LEDGER } from "./ledgerFixtures";
import { type LedgerScope, LedgerScopeToggle, LedgerWorkersView } from "./LedgerWorkersView";
import { LedgerPanel } from "./ThreadLedgerPanel";
import { DIRECTOR_WORKERS } from "./workerFixtures";

const scribe = { turnModel: "haiku", sweepModel: "sonnet", sweepEvery: 8 };

/** The panel's switch between the thread's ledger and its workers, as ThreadLedgerPanel wires it. */
function DirectorPanel(props: {
  readonly ledger: typeof BUSY_LEDGER;
  readonly onOpenWorker: (threadId: string) => void;
}) {
  const [scope, setScope] = useState<LedgerScope>("workers");
  const toggle = <LedgerScopeToggle value={scope} onChange={setScope} />;
  return (
    <div style={{ width: 440, height: 900, display: "flex", flexDirection: "column" }}>
      {scope === "workers" ? (
        <LedgerWorkersView
          title="7 days Director"
          workers={DIRECTOR_WORKERS}
          scopeToggle={toggle}
          onOpenWorker={props.onOpenWorker}
        />
      ) : (
        <LedgerPanel
          ledger={props.ledger}
          title="7 days Director"
          scribe={scribe}
          canTurnOn
          onTurnOn={vi.fn()}
          scopeToggle={toggle}
        />
      )}
    </div>
  );
}

describe("LedgerWorkersView", () => {
  it("groups the workers as the mockup does, with settled ones folded", async () => {
    const onOpenWorker = vi.fn();
    await using screen = await render(
      <DirectorPanel ledger={BUSY_LEDGER} onOpenWorker={onOpenWorker} />,
    );

    await expect.element(screen.getByRole("heading", { name: "7 days Director" })).toBeVisible();
    await expect.element(screen.getByText("8 workers · from their ledgers")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Workers" }))
      .toHaveAttribute("aria-pressed", "true");

    const needs = screen.getByRole("region", { name: "Needs you" });
    await expect.element(needs.getByText("Stone textures T.2")).toBeVisible();
    await expect.element(needs.getByText("Input")).toBeVisible();
    await expect
      .element(needs.getByText("Approve stone batch 2 (slate, phyllite, chert)?"))
      .toBeVisible();
    await expect
      .element(needs.getByText("Stone textures · Claude recommends: Approve it"))
      .toBeVisible();
    await expect.element(needs.getByText("Review")).toBeVisible();

    const working = screen.getByRole("region", { name: "Working" });
    await expect.element(working.getByText("Grab and trade animations")).toBeVisible();
    await expect
      .element(working.getByText("Next: Wire the trade bump · 3 of 5 to-dos done"))
      .toBeVisible();

    const quiet = screen.getByRole("region", { name: "Quiet" });
    await expect.element(quiet.getByText("Ledger off for this thread")).toBeVisible();

    const settled = screen.getByRole("region", { name: "Settled" });
    await expect.element(settled.getByText("Old save format")).not.toBeInTheDocument();
    await userEvent.click(settled.getByRole("button", { name: /Settled/ }));
    await expect.element(settled.getByText("Old save format")).toBeVisible();

    await userEvent.click(working.getByRole("button", { name: /Hit reactions/ }));
    expect(onOpenWorker).toHaveBeenCalledWith("thread-hits");
  });

  it("switches back to the thread's own ledger, and keeps the switch when it is off", async () => {
    await using screen = await render(<DirectorPanel ledger={OFF_LEDGER} onOpenWorker={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: "This thread" }));
    await expect.element(screen.getByText("Ledger is off for this thread")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "This thread" }))
      .toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Workers" }));
    await expect.element(screen.getByRole("region", { name: "Needs you" })).toBeVisible();
  });
});
