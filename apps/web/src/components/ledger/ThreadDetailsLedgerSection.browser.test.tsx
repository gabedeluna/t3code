import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";
import { render } from "../../../test/render";
import { BUSY_LEDGER, OFF_LEDGER, SETTLED_LEDGER } from "./ledgerFixtures";
import { ThreadDetailsLedger } from "./ThreadDetailsLedgerSection";

function section(props: Partial<Parameters<typeof ThreadDetailsLedger>[0]> = {}) {
  return (
    <div style={{ width: 280 }}>
      <ThreadDetailsLedger
        ledger={BUSY_LEDGER}
        canToggle
        onEnabledChange={vi.fn()}
        onOpen={vi.fn()}
        {...props}
      />
    </div>
  );
}

describe("ThreadDetailsLedger", () => {
  it("shows what waits on the user and the topics in play", async () => {
    const onOpen = vi.fn();
    const onEnabledChange = vi.fn();
    await using screen = await render(section({ onOpen, onEnabledChange }));

    const region = screen.getByRole("region", { name: "Ledger" });
    await expect.element(region.getByText("turn 41")).toBeVisible();
    const ledgerSwitch = region.getByRole("switch", { name: "Ledger for this thread" });
    await expect.element(ledgerSwitch).toBeChecked();

    await expect.element(region.getByRole("button", { name: "2 questions for you" })).toBeVisible();
    await expect.element(region.getByRole("button", { name: "1 check for you" })).toBeVisible();

    const topics = region.getByRole("list", { name: "Topics in play" }).getByRole("listitem");
    await expect.element(topics.nth(0)).toHaveTextContent("Attack slotsActive");
    await expect.element(topics.nth(1)).toHaveTextContent("Fight-scene CPU costReview");
    await expect.element(topics.nth(2)).toHaveTextContent("Skills and XP, milestone 1Chosen");
    expect(topics.elements()).toHaveLength(3);

    const open = region.getByRole("button", { name: /Open ledger/ });
    await expect.element(open).toHaveTextContent("+ 1 on hold, 2 doneOpen ledger");
    await userEvent.click(open);
    await userEvent.click(region.getByRole("button", { name: "2 questions for you" }));
    expect(onOpen).toHaveBeenCalledTimes(2);

    await userEvent.click(ledgerSwitch);
    expect(onEnabledChange).toHaveBeenCalledWith(false);
  });

  it("hides the rows for the user when nothing waits on them", async () => {
    await using screen = await render(section({ ledger: SETTLED_LEDGER }));

    const region = screen.getByRole("region", { name: "Ledger" });
    await expect.element(region.getByText("turn 3")).toBeVisible();
    await expect.element(region.getByRole("button", { name: /for you/ })).not.toBeInTheDocument();
    await expect.element(region.getByRole("list")).not.toBeInTheDocument();
    await expect
      .element(region.getByRole("button", { name: /Open ledger/ }))
      .toHaveTextContent("+ 1 doneOpen ledger");
  });

  it("collapses to one row with the switch while off", async () => {
    const onOpen = vi.fn();
    const onEnabledChange = vi.fn();
    await using screen = await render(section({ ledger: OFF_LEDGER, onOpen, onEnabledChange }));

    const region = screen.getByRole("region", { name: "Ledger" });
    await expect.element(region.getByRole("heading")).not.toBeInTheDocument();
    const row = region.getByRole("button", { name: /Ledger/ });
    await expect.element(row).toHaveTextContent("LedgerOff");
    await expect.element(row).toBeVisible();
    await expect.element(region.getByRole("button", { name: /for you/ })).not.toBeInTheDocument();

    const ledgerSwitch = region.getByRole("switch", { name: "Ledger for this thread" });
    await expect.element(ledgerSwitch).not.toBeChecked();
    await userEvent.click(ledgerSwitch);
    expect(onEnabledChange).toHaveBeenCalledWith(true);
    await userEvent.click(row);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it("disables the switch without permission to change the thread", async () => {
    await using screen = await render(section({ canToggle: false }));
    await expect
      .element(screen.getByRole("switch", { name: "Ledger for this thread" }))
      .toBeDisabled();
  });
});
