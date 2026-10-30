import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useRef, useState } from "react";

import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import {
  resolveThreadDetailsVisibility,
  setThreadDetailsItem,
  THREAD_DETAILS_ITEMS,
} from "../chat/threadDetailsItems";
import { ledgerModelLabel } from "../ledger/ledger.logic";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/** Claude model aliases the scribe can run on. A value typed elsewhere stays listed. */
const LEDGER_MODEL_ALIASES = ["haiku", "sonnet"] as const;
const MIN_SWEEP_EVERY = 1;
const MAX_SWEEP_EVERY = 100;
const LEDGER_ITEM = THREAD_DETAILS_ITEMS.find((item) => item.id === "ledger")!;

function LedgerModelSelect(props: {
  readonly value: string | null;
  readonly label: string;
  readonly onChange: (model: string) => void;
}) {
  const options =
    props.value === null || (LEDGER_MODEL_ALIASES as readonly string[]).includes(props.value)
      ? LEDGER_MODEL_ALIASES
      : [...LEDGER_MODEL_ALIASES, props.value];
  return (
    <Select
      value={props.value}
      onValueChange={(value) => {
        if (typeof value === "string" && value !== "") props.onChange(value);
      }}
    >
      <SelectTrigger size="sm" className="w-full sm:w-32" aria-label={props.label}>
        <SelectValue>
          {(value: string | null) => (value === null ? "Mixed" : ledgerModelLabel(value))}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map((model) => (
          <SelectItem key={model} hideIndicator value={model}>
            {ledgerModelLabel(model)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function SweepEveryInput(props: {
  readonly value: number;
  readonly onCommit: (every: number) => void;
}) {
  const [draft, setDraft] = useState(String(props.value));
  const [draftSource, setDraftSource] = useState(props.value);
  if (draftSource !== props.value) {
    setDraftSource(props.value);
    setDraft(String(props.value));
  }
  return (
    <Input
      size="sm"
      type="number"
      min={MIN_SWEEP_EVERY}
      max={MAX_SWEEP_EVERY}
      className="w-16"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        const parsed = Number(event.target.value);
        if (Number.isInteger(parsed) && parsed >= MIN_SWEEP_EVERY && parsed <= MAX_SWEEP_EVERY) {
          props.onCommit(parsed);
        }
      }}
      onBlur={() => setDraft(String(props.value))}
      aria-label="Turns between cleanup passes"
    />
  );
}

/** The thread ledger's scribe: its models, how often it cleans up, and what it calls the user. */
export function LedgerSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const mixedTurnModel = useScopedSettingsMixed(["ledgerTurnModel"]);
  const mixedSweep = useScopedSettingsMixed(["ledgerSweepModel", "ledgerSweepEvery"]);
  const mixedSweepModel = useScopedSettingsMixed(["ledgerSweepModel"]);
  const mixedUserName = useScopedSettingsMixed(["ledgerUserName"]);
  const userNameEdited = useRef(false);
  const showInDetails = useClientSettings(
    (clientSettings) => resolveThreadDetailsVisibility(clientSettings).ledger,
  );
  const defaults = DEFAULT_UNIFIED_SETTINGS;

  return (
    <SettingsSection id="thread-ledger" title="Ledger">
      <SettingsRow
        serverScoped
        settingKeys={["ledgerTurnModel"]}
        mixed={mixedTurnModel}
        {...searchableSetting("ledger-turn-model")}
        description="Writes the ledger after every turn, in threads where it's on. Fast and cheap."
        resetAction={
          settings.ledgerTurnModel !== defaults.ledgerTurnModel ? (
            <SettingResetButton
              label="ledger turn model"
              onClick={() => updateSettings({ ledgerTurnModel: defaults.ledgerTurnModel })}
            />
          ) : null
        }
        control={
          <LedgerModelSelect
            value={mixedTurnModel ? null : settings.ledgerTurnModel}
            label="Model that reads each turn"
            onChange={(ledgerTurnModel) => updateSettings({ ledgerTurnModel })}
          />
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["ledgerSweepModel", "ledgerSweepEvery"]}
        mixed={mixedSweep}
        {...searchableSetting("ledger-sweep")}
        description="Rechecks every open item against the recent turns."
        resetAction={
          settings.ledgerSweepModel !== defaults.ledgerSweepModel ||
          settings.ledgerSweepEvery !== defaults.ledgerSweepEvery ? (
            <SettingResetButton
              label="ledger cleanup pass"
              onClick={() =>
                updateSettings({
                  ledgerSweepModel: defaults.ledgerSweepModel,
                  ledgerSweepEvery: defaults.ledgerSweepEvery,
                })
              }
            />
          ) : null
        }
        control={
          <div className="flex items-center gap-2">
            <LedgerModelSelect
              value={mixedSweepModel ? null : settings.ledgerSweepModel}
              label="Model for the cleanup pass"
              onChange={(ledgerSweepModel) => updateSettings({ ledgerSweepModel })}
            />
            <span className="shrink-0 text-xs text-muted-foreground">every</span>
            <SweepEveryInput
              value={settings.ledgerSweepEvery}
              onCommit={(ledgerSweepEvery) => updateSettings({ ledgerSweepEvery })}
            />
            <span className="shrink-0 text-xs text-muted-foreground">turns</span>
          </div>
        }
      />
      <SettingsRow
        serverScoped
        settingKeys={["ledgerUserName"]}
        mixed={mixedUserName}
        {...searchableSetting("ledger-user-name")}
        description="How the scribe refers to you."
        resetAction={
          settings.ledgerUserName !== defaults.ledgerUserName ? (
            <SettingResetButton
              label="your name in the ledger"
              onClick={() => updateSettings({ ledgerUserName: defaults.ledgerUserName })}
            />
          ) : null
        }
        control={
          <Input
            key={`${scopeKey}:${mixedUserName}:${settings.ledgerUserName}`}
            size="sm"
            className="w-full sm:w-48"
            aria-label="Your name in the ledger"
            defaultValue={mixedUserName ? "" : settings.ledgerUserName}
            placeholder={mixedUserName ? "Mixed" : defaults.ledgerUserName}
            onChange={() => {
              userNameEdited.current = true;
            }}
            onBlur={(event) => {
              const value = event.target.value.trim();
              // An empty name keeps the current one; the reset button restores the default.
              if (
                userNameEdited.current &&
                value !== "" &&
                (mixedUserName || value !== settings.ledgerUserName)
              ) {
                updateSettings({ ledgerUserName: value });
              } else {
                event.target.value = mixedUserName ? "" : settings.ledgerUserName;
              }
              userNameEdited.current = false;
            }}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("ledger-thread-details")}
        title="Show in thread details"
        description="Questions for you and the topics in play, in the thread details card."
        control={
          <Switch
            checked={showInDetails}
            onCheckedChange={(checked) =>
              updateClientSettings({
                threadDetailsItems: setThreadDetailsItem(
                  getClientSettings(),
                  LEDGER_ITEM,
                  Boolean(checked),
                ),
              })
            }
            aria-label="Show the ledger in thread details"
          />
        }
      />
    </SettingsSection>
  );
}
