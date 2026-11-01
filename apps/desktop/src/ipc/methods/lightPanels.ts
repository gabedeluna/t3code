// @effect-diagnostics nodeBuiltinImport:off -- Fire-and-forget launch of the local Nanoleaf controller script.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { FLASH_LIGHT_PANELS_CHANNEL } from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

/** The ripple plays for 4 s; completions that land while it plays share it. */
const RIPPLE_MS = 4_000;
let lastRippleAt = 0;

const lightPanelsScriptPath = () =>
  NodePath.join(NodeOS.homedir(), ".claude", "skills", "nanoleaf", "scripts", "nanoleaf.py");

export const flashLightPanels = DesktopIpc.makeIpcMethod({
  channel: FLASH_LIGHT_PANELS_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.lightPanels.flash")(function* () {
    const script = lightPanelsScriptPath();
    if (!NodeFS.existsSync(script)) return false;
    const platform = yield* HostProcess.Platform;
    const now = yield* Clock.currentTimeMillis;
    if (now - lastRippleAt < RIPPLE_MS) return true;
    lastRippleAt = now;
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    yield* Effect.sync(() => {
      // pythonw has no console window; the script checks the panels are on and reachable itself.
      const child = NodeChildProcess.spawn(
        platform === "win32" ? "pythonw" : "python3",
        [script, "done"],
        { detached: true, stdio: "ignore", windowsHide: true },
      );
      child.on("error", (error) =>
        runFork(Effect.logWarning("Could not run the light panels controller", error)),
      );
      child.unref();
    });
    return true;
  }),
});
