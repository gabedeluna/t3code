/**
 * Hold-to-talk while the window is focused. Times are event timestamps, so a hold's length
 * needs no clock read.
 *
 * The window's key events are one source. A global hold key from the desktop main process
 * would be a second source driving the same press, release and abort on the newest target.
 */
export interface VoiceHoldTarget {
  /** A `KeyboardEvent.code`, read on each press so a settings change applies at once. */
  readonly holdKey: () => string | null;
  readonly press: (atMs: number) => void | Promise<void>;
  readonly release: (atMs: number) => void | Promise<void>;
  /** Another key joined the hold key, so it was a shortcut chord, not dictation. */
  readonly abort: () => void;
}

const targets: VoiceHoldTarget[] = [];
let heldKey: string | null = null;

const topTarget = () => targets.at(-1);

function handleKeyDown(event: KeyboardEvent): void {
  if (heldKey !== null) {
    if (event.code !== heldKey) {
      heldKey = null;
      topTarget()?.abort();
    }
    return;
  }
  const holdKey = topTarget()?.holdKey() ?? null;
  if (holdKey === null || event.code !== holdKey || event.repeat) return;
  heldKey = holdKey;
  void topTarget()?.press(event.timeStamp);
}

function handleKeyUp(event: KeyboardEvent): void {
  if (heldKey === null || event.code !== heldKey) return;
  heldKey = null;
  void topTarget()?.release(event.timeStamp);
}

// The key-up never arrives once focus leaves the window, so leaving ends the hold.
function handleWindowBlur(event: FocusEvent): void {
  if (heldKey === null) return;
  heldKey = null;
  void topTarget()?.release(event.timeStamp);
}

/** The newest target wins. */
export function registerVoiceHoldTarget(target: VoiceHoldTarget): () => void {
  if (targets.length === 0) {
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("blur", handleWindowBlur);
  }
  targets.push(target);
  return () => {
    const index = targets.lastIndexOf(target);
    if (index !== -1) targets.splice(index, 1);
    if (targets.length > 0) return;
    heldKey = null;
    window.removeEventListener("keydown", handleKeyDown, true);
    window.removeEventListener("keyup", handleKeyUp, true);
    window.removeEventListener("blur", handleWindowBlur);
  };
}

const SIDED_KEY = /^(Control|Alt|Shift|Meta)(Left|Right)$/;
const FUNCTION_KEY = /^F([1-9]|1\d|2[0-4])$/;
const OTHER_HOLDABLE_KEYS = new Set(["CapsLock", "ScrollLock", "Pause", "Insert", "ContextMenu"]);

/** Keys that type nothing, so holding one to talk leaves the draft alone. */
export function isHoldableVoiceKey(code: string): boolean {
  return SIDED_KEY.test(code) || FUNCTION_KEY.test(code) || OTHER_HOLDABLE_KEYS.has(code);
}

/** "Right Ctrl" for `ControlRight`, in the platform's own key names. */
export function voiceHoldKeyLabel(code: string, apple: boolean): string {
  const sided = SIDED_KEY.exec(code);
  if (sided) {
    const [, modifier, side] = sided;
    const names: Record<string, string> = apple
      ? { Control: "Control", Alt: "Option", Shift: "Shift", Meta: "Command" }
      : { Control: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Win" };
    return `${side} ${names[modifier!]}`;
  }
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code.replace(/([a-z])([A-Z])/g, "$1 $2");
}
