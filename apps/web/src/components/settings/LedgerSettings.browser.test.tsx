import { render } from "../../../test/render";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import type { ScopedSettingsPatch } from "./scopedSettings";

const state = vi.hoisted(() => ({
  overrides: {} as Record<string, unknown>,
  updateSettings: vi.fn<(patch: ScopedSettingsPatch) => void>(),
}));

vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({ ...DEFAULT_UNIFIED_SETTINGS, ...state.overrides })) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.updateSettings,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "environment", environmentIds: [] },
    environment: null,
    connectedEnvironments: [],
    targets: [],
    target: null,
  })) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ title, description, control, resetAction }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      {control}
      {resetAction}
    </div>
  ),
  SettingsSection: (({ children }: { children: ReactNode }) => children) as never,
}));

import { LedgerSettingsSection } from "./LedgerSettings";

async function setup(overrides: Record<string, unknown> = {}) {
  state.overrides = overrides;
  state.updateSettings.mockClear();
  return await render(<LedgerSettingsSection />);
}

describe("LedgerSettingsSection", () => {
  it("shows the scribe's defaults", async () => {
    await using _screen = await setup();
    await expect.element(page.getByRole("heading", { name: "Reads each turn" })).toBeVisible();
    await expect
      .element(page.getByRole("combobox", { name: "Model that reads each turn" }))
      .toHaveTextContent("Haiku");
    await expect
      .element(page.getByRole("combobox", { name: "Model for the cleanup pass" }))
      .toHaveTextContent("Sonnet");
    await expect
      .element(page.getByRole("spinbutton", { name: "Turns between cleanup passes" }))
      .toHaveValue(8);
    await expect
      .element(page.getByRole("textbox", { name: "Your name in the ledger" }))
      .toHaveValue("the user");
    await expect
      .element(page.getByRole("switch", { name: "Show the ledger in thread details" }))
      .toBeChecked();
    await expect.element(page.getByRole("button", { name: /Reset/ })).not.toBeInTheDocument();
  });

  it("patches the models, the cleanup cadence and the user's name", async () => {
    await using _screen = await setup();

    await userEvent.click(page.getByRole("combobox", { name: "Model that reads each turn" }));
    await userEvent.click(page.getByRole("option", { name: "Sonnet" }));
    expect(state.updateSettings).toHaveBeenCalledWith({ ledgerTurnModel: "sonnet" });

    await userEvent.fill(
      page.getByRole("spinbutton", { name: "Turns between cleanup passes" }),
      "12",
    );
    expect(state.updateSettings).toHaveBeenCalledWith({ ledgerSweepEvery: 12 });

    const name = page.getByRole("textbox", { name: "Your name in the ledger" });
    await userEvent.fill(name, "  Gabe ");
    await userEvent.click(page.getByRole("heading", { name: "Cleanup pass" }));
    expect(state.updateSettings).toHaveBeenCalledWith({ ledgerUserName: "Gabe" });
  });

  it("ignores a cadence out of range and keeps an emptied name", async () => {
    await using _screen = await setup();

    await userEvent.fill(
      page.getByRole("spinbutton", { name: "Turns between cleanup passes" }),
      "0",
    );
    const name = page.getByRole("textbox", { name: "Your name in the ledger" });
    await userEvent.fill(name, "");
    await userEvent.click(page.getByRole("heading", { name: "Cleanup pass" }));
    expect(state.updateSettings).not.toHaveBeenCalled();
    await expect.element(name).toHaveValue("the user");
  });

  it("resets changed rows to their defaults", async () => {
    await using _screen = await setup({ ledgerSweepModel: "haiku", ledgerSweepEvery: 3 });
    await userEvent.click(
      page.getByRole("button", { name: "Reset ledger cleanup pass to default" }),
    );
    expect(state.updateSettings).toHaveBeenCalledWith({
      ledgerSweepModel: "sonnet",
      ledgerSweepEvery: 8,
    });
  });
});
