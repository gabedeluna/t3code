import {
  DEFAULT_VOICE_INPUT_HOLD_KEY,
  DEFAULT_VOICE_INPUT_LANGUAGE,
  DEFAULT_VOICE_INPUT_MODE,
  VOICE_INPUT_MAX_KEYTERMS,
  VOICE_INPUT_MAX_REALTIME_KEYTERM_LENGTH,
  VOICE_INPUT_MAX_REALTIME_KEYTERMS,
} from "@t3tools/contracts";
import { useState } from "react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { isMacPlatform } from "../../lib/utils";
import { desktopVoiceInputStatusAtom } from "../../state/desktopVoiceInput";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import {
  getDesktopVoiceInputBridge,
  type DesktopVoiceInputBridge,
} from "../../voiceInput/desktopVoiceTranscriber";
import { isHoldableVoiceKey, voiceHoldKeyLabel } from "../../voiceInput/voiceHoldKey";
import {
  resolveVoiceKeyterms,
  VOICE_KEYTERM_WARNING_THRESHOLD,
} from "../../voiceInput/voiceKeyterms";
import { VOICE_INPUT_SETTINGS_SECTION_ID } from "../chat/useComposerVoiceInput";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SecretInput } from "./SecretInput";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const VOICE_INPUT_LANGUAGES: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: "en", label: "English" },
  { value: "auto", label: "Detect automatically" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "it", label: "Italian" },
  { value: "pt", label: "Portuguese" },
  { value: "nl", label: "Dutch" },
  { value: "ja", label: "Japanese" },
  { value: "zh", label: "Chinese" },
];

function languageLabel(value: string): string {
  return VOICE_INPUT_LANGUAGES.find((language) => language.value === value)?.label ?? value;
}

function ApiKeyRow(props: { readonly bridge: DesktopVoiceInputBridge }) {
  const statusQuery = useEnvironmentQuery(desktopVoiceInputStatusAtom);
  const status = statusQuery.data;
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const configured = status?.apiKeyConfigured ?? false;

  const save = (apiKey: string) => {
    if (saving) return;
    setSaving(true);
    void props.bridge
      .setApiKey(apiKey)
      .then((next) => {
        statusQuery.refresh();
        if (apiKey.trim() !== "" && !next.apiKeyConfigured) {
          toastManager.add({
            type: "error",
            title: "The key was not stored",
            description: "Your system keychain is unavailable on this computer.",
          });
          return;
        }
        setDraft("");
      })
      .catch((error: unknown) => {
        toastManager.add({
          type: "error",
          title: "Could not save the ElevenLabs key",
          description: error instanceof Error ? error.message : "Something went wrong.",
        });
      })
      .finally(() => setSaving(false));
  };

  return (
    <SettingsRow
      {...searchableSetting("voice-input-api-key")}
      description="Dictation sends recordings to ElevenLabs Scribe with this key. It stays encrypted in your system keychain on this computer and never reaches the chat."
      status={
        status && !status.encryptionAvailable
          ? "Your system keychain is unavailable, so a key cannot be stored."
          : null
      }
      control={
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <SecretInput
            size="sm"
            className="w-full sm:w-56"
            aria-label="ElevenLabs API key"
            configured={configured}
            value={draft}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && draft.trim() !== "") save(draft);
            }}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={saving || draft.trim() === ""}
            onClick={() => save(draft)}
          >
            Save
          </Button>
          {configured ? (
            <Button size="sm" variant="outline" disabled={saving} onClick={() => save("")}>
              Remove
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

function ModeRow() {
  const mode = useClientSettings((settings) => settings.voiceInputMode);
  return (
    <SettingsRow
      {...searchableSetting("voice-input-mode")}
      description="Words appear as you speak, faded until ElevenLabs settles them. Off transcribes once you stop, which costs about half as much."
      resetAction={
        mode !== DEFAULT_VOICE_INPUT_MODE ? (
          <SettingResetButton
            label="live dictation"
            onClick={() => void updateClientSettings({ voiceInputMode: DEFAULT_VOICE_INPUT_MODE })}
          />
        ) : null
      }
      control={
        <Switch
          checked={mode === "streaming"}
          onCheckedChange={(checked) =>
            void updateClientSettings({ voiceInputMode: checked ? "streaming" : "batch" })
          }
          aria-label="Live dictation"
        />
      }
    />
  );
}

function LanguageRow() {
  const language = useClientSettings((settings) => settings.voiceInputLanguage);
  const options = VOICE_INPUT_LANGUAGES.some((option) => option.value === language)
    ? VOICE_INPUT_LANGUAGES
    : [...VOICE_INPUT_LANGUAGES, { value: language, label: language }];
  return (
    <SettingsRow
      {...searchableSetting("voice-input-language")}
      description="Naming the language is faster and more accurate than detecting it."
      resetAction={
        language !== DEFAULT_VOICE_INPUT_LANGUAGE ? (
          <SettingResetButton
            label="dictation language"
            onClick={() =>
              void updateClientSettings({ voiceInputLanguage: DEFAULT_VOICE_INPUT_LANGUAGE })
            }
          />
        ) : null
      }
      control={
        <Select
          value={language}
          onValueChange={(value) => {
            if (typeof value === "string" && value !== "") {
              void updateClientSettings({ voiceInputLanguage: value });
            }
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-48" aria-label="Dictation language">
            <SelectValue>{(value: string | null) => languageLabel(value ?? language)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {options.map((option) => (
              <SelectItem key={option.value} hideIndicator value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function HoldKeyRow() {
  const holdKey = useClientSettings((settings) => settings.voiceInputHoldKey);
  const [listening, setListening] = useState(false);
  const [rejected, setRejected] = useState(false);
  const apple = isMacPlatform(navigator.platform);
  return (
    <SettingsRow
      {...searchableSetting("voice-input-hold-key")}
      description="Hold this key while T3 Code is focused to dictate, and let go to transcribe. Use a key that types nothing, such as a modifier or a function key."
      status={rejected ? "That key types text. Pick a modifier or a function key." : null}
      resetAction={
        holdKey !== DEFAULT_VOICE_INPUT_HOLD_KEY ? (
          <SettingResetButton
            label="hold to talk key"
            onClick={() =>
              void updateClientSettings({ voiceInputHoldKey: DEFAULT_VOICE_INPUT_HOLD_KEY })
            }
          />
        ) : null
      }
      control={
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="min-w-28"
            aria-label="Key to hold to talk"
            aria-pressed={listening}
            onClick={() => {
              setRejected(false);
              setListening(true);
            }}
            onBlur={() => setListening(false)}
            onKeyDown={(event) => {
              if (!listening) return;
              event.preventDefault();
              event.stopPropagation();
              if (event.key === "Escape") {
                setListening(false);
                return;
              }
              if (!isHoldableVoiceKey(event.nativeEvent.code)) {
                setRejected(true);
                return;
              }
              setListening(false);
              void updateClientSettings({ voiceInputHoldKey: event.nativeEvent.code });
            }}
          >
            {listening
              ? "Press a key"
              : holdKey === null
                ? "Off"
                : voiceHoldKeyLabel(holdKey, apple)}
          </Button>
          {holdKey !== null ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void updateClientSettings({ voiceInputHoldKey: null })}
            >
              Turn off
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

function parseKeyterms(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function KeytermsRow() {
  const keyterms = useClientSettings((settings) => settings.voiceInputKeyterms);
  const projects = useProjects();
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft === null ? keyterms : parseKeyterms(draft);
  const projectNames = projects
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .map((project) => project.title);
  const resolved = resolveVoiceKeyterms(editing, projectNames);
  const live = useClientSettings((settings) => settings.voiceInputMode) === "streaming";
  const realtime = resolveVoiceKeyterms(editing, projectNames, "realtime");
  const total = resolved.keyterms.length;
  const warning =
    resolved.omitted > 0
      ? `${resolved.omitted} more left out. Above ${VOICE_INPUT_MAX_KEYTERMS} keyterms ElevenLabs bills every request as at least 20 seconds, so only the first ${VOICE_INPUT_MAX_KEYTERMS} are sent, yours before project names.`
      : total >= VOICE_KEYTERM_WARNING_THRESHOLD
        ? `Close to the limit. Above ${VOICE_INPUT_MAX_KEYTERMS} keyterms ElevenLabs bills every request as at least 20 seconds.`
        : null;

  return (
    <SettingsRow
      {...searchableSetting("voice-input-keyterms")}
      description="Names and jargon ElevenLabs should spell your way, one per line. Your project names are added for you."
      status={
        <div className="space-y-1">
          <p>
            {`${total} of ${VOICE_INPUT_MAX_KEYTERMS} keyterms: ${resolved.customCount} yours, ${resolved.projectCount} project names.`}
          </p>
          {live ? (
            <p>
              {`Live dictation takes the first ${realtime.keyterms.length} of at most ${VOICE_INPUT_MAX_REALTIME_KEYTERMS}${realtime.tooLong > 0 ? `, skipping ${realtime.tooLong} over ${VOICE_INPUT_MAX_REALTIME_KEYTERM_LENGTH} characters` : ""}.`}
            </p>
          ) : null}
          {warning ? <p className="text-warning-foreground">{warning}</p> : null}
          {resolved.invalid.length > 0 ? (
            <p className="text-warning-foreground">
              {`Skipped ${resolved.invalid.map((term) => `"${term}"`).join(", ")}: keyterms must be under 50 characters and 5 words, without < > { } [ ] or \\.`}
            </p>
          ) : null}
        </div>
      }
    >
      <div className="pb-3 pt-2">
        <Textarea
          size="sm"
          aria-label="Dictation keyterms"
          placeholder="Add a word ElevenLabs mishears, one per line"
          value={draft ?? keyterms.join("\n")}
          onFocus={() => setDraft(keyterms.join("\n"))}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            const next = draft === null ? keyterms : parseKeyterms(draft);
            setDraft(null);
            if (next.join("\n") !== keyterms.join("\n")) {
              void updateClientSettings({ voiceInputKeyterms: next });
            }
          }}
        />
      </div>
    </SettingsRow>
  );
}

/** Dictation through ElevenLabs Scribe. Desktop only: the key lives in the main process. */
export function VoiceInputSettingsSection() {
  const bridge = getDesktopVoiceInputBridge();
  if (!bridge) return null;
  return (
    <SettingsSection id={VOICE_INPUT_SETTINGS_SECTION_ID} title="Voice input">
      <ApiKeyRow bridge={bridge} />
      <ModeRow />
      <LanguageRow />
      <HoldKeyRow />
      <KeytermsRow />
    </SettingsSection>
  );
}
