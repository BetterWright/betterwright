// The BetterWright home directory: where the profile, vault, daemon socket,
// sessions, and config all live. Kept as its own dependency-free module so the
// client, daemon, vault, and live-view config can all share the one resolution
// rule without importing each other (client -> daemon in particular would be a
// cycle).

import os from "node:os";
import path from "node:path";

/** BETTERWRIGHT_HOME when set (trimmed), otherwise ~/.betterwright. */
export function defaultHome() {
  const configured = (process.env.BETTERWRIGHT_HOME || "").trim();
  return configured || path.join(os.homedir(), ".betterwright");
}
