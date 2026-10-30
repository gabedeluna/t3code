import type {
  ClientSettingsPatch,
  DesktopBridge,
  DesktopVoiceInputStatus,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  projectTitles: [] as string[],
  keyterms: [] as string[],
  updateClientSettings: vi.fn<(patch: ClientSettingsPatch) => Promise<void>>(),
}));

vi.mock(import("../../hooks/useSettings"), async (original) => {
  const { DEFAULT_CLIENT_SETTINGS } = await import("@t3tools/contracts");
  return {
    ...(await original()),
    useClientSettings: ((select: (settings: typeof DEFAULT_CLIENT_SETTINGS) => unknown) =>
      select({ ...DEFAULT_CLIENT_SETTINGS, voiceInputKeyterms: state.keyterms })) as never,
    updateClientSettings: state.updateClientSettings,
  };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() =>
    state.projectTitles.map((title, index) => ({
      title,
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
    }))) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ title, description, status, control, children }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      <div>{status}</div>
      {control}
      {children}
    </div>
  ),
  SettingsSection: (({ children }: { children: ReactNode }) => children) as never,
}));

import { VoiceInputSettingsSection } from "./VoiceInputSettings";

function setup(options: { projectTitles?: string[]; keyterms?: string[] } = {}) {
  state.projectTitles = options.projectTitles ?? [];
  state.keyterms = options.keyterms ?? [];
  state.updateClientSettings.mockReset();
  state.updateClientSettings.mockResolvedValue();
  let status: DesktopVoiceInputStatus = { apiKeyConfigured: false, encryptionAvailable: true };
  const setApiKey = vi.fn(async (apiKey: string) => {
    status = { ...status, apiKeyConfigured: apiKey.trim() !== "" };
    return status;
  });
  const voiceInput: DesktopBridge["voiceInput"] = {
    getStatus: async () => status,
    setApiKey,
    transcribe: async () => ({ _tag: "failed", reason: "failed" }),
  };
  window.desktopBridge = { voiceInput } as DesktopBridge;
  return {
    setApiKey,
    [Symbol.dispose]: () => {
      delete window.desktopBridge;
    },
  };
}

describe("VoiceInputSettingsSection", () => {
  it("hands the key to the desktop app and keeps none of it in the page", async () => {
    using bridge = setup();
    await using _screen = await render(<VoiceInputSettingsSection />);
    const field = page.getByLabelText("ElevenLabs API key");

    await userEvent.fill(field, "sk_live_123");
    await userEvent.click(page.getByRole("button", { name: "Save" }));

    expect(bridge.setApiKey).toHaveBeenCalledWith("sk_live_123");
    await expect.element(field).toHaveValue("");
    await userEvent.click(page.getByRole("button", { name: "Remove" }));
    expect(bridge.setApiKey).toHaveBeenLastCalledWith("");
  });

  it("records a hold key, refusing one that types text", async () => {
    using _bridge = setup();
    await using _screen = await render(<VoiceInputSettingsSection />);
    const recorder = page.getByRole("button", { name: "Key to hold to talk" });

    await expect.element(recorder).toMatchTextContent(/^Right (Ctrl|Control)$/);
    await userEvent.click(recorder);
    await userEvent.keyboard("a");
    await expect.element(page.getByText("That key types text.", { exact: false })).toBeVisible();
    await userEvent.keyboard("{AltRight}");

    expect(state.updateClientSettings).toHaveBeenCalledTimes(1);
    expect(state.updateClientSettings).toHaveBeenCalledWith({ voiceInputHoldKey: "AltRight" });
  });

  it("warns as keyterms near the 100 that ElevenLabs bills normally", async () => {
    using _bridge = setup({
      keyterms: ["Effect", "TanStack"],
      projectTitles: Array.from({ length: 90 }, (_, index) => `project-${index}`),
    });
    await using screen = await render(<VoiceInputSettingsSection />);

    await expect
      .element(page.getByText("92 of 100 keyterms: 2 yours, 90 project names."))
      .toBeVisible();
    await expect.element(page.getByText("Close to the limit.", { exact: false })).toBeVisible();

    state.projectTitles = Array.from({ length: 105 }, (_, index) => `project-${index}`);
    await screen.rerender(<VoiceInputSettingsSection key="more-projects" />);
    await expect
      .element(page.getByText("100 of 100 keyterms: 2 yours, 98 project names."))
      .toBeVisible();
    await expect.element(page.getByText("7 more left out.", { exact: false })).toBeVisible();
  });
});
