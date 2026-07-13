import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_CDP_PORT = 9223;
const START_TIMEOUT_MS = 12_000;

export function chromeExecutableCandidates(platform = process.platform) {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(
        os.homedir(),
        "Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      ),
    ];
  }
  if (platform === "win32") {
    return [
      path.join(
        process.env.PROGRAMFILES || "C:\\Program Files",
        "Google/Chrome/Application/chrome.exe",
      ),
      path.join(
        process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
        "Google/Chrome/Application/chrome.exe",
      ),
      path.join(
        process.env.LOCALAPPDATA || "",
        "Google/Chrome/Application/chrome.exe",
      ),
    ];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"];
}

export function findChromeExecutable(explicit = "") {
  const requested = String(explicit || "").trim();
  if (requested && fs.existsSync(requested)) return requested;
  return chromeExecutableCandidates().find((candidate) => fs.existsSync(candidate)) || null;
}

async function endpointReady(endpoint) {
  try {
    const response = await fetch(`${endpoint}/json/version`, {
      signal: AbortSignal.timeout(750),
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return Boolean(payload?.webSocketDebuggerUrl);
  } catch {
    return false;
  }
}

/** Start (or reuse) a dedicated, persistent Google Chrome CDP profile. */
export async function ensureChromeCdp(options = {}) {
  const configuredHome = String(
    options.home || process.env.BETTERWRIGHT_HOME || path.join(os.homedir(), ".betterwright"),
  );
  const port = Math.max(1024, Math.min(Number(options.port) || DEFAULT_CDP_PORT, 65535));
  const endpoint = `http://127.0.0.1:${port}`;
  if (await endpointReady(endpoint)) {
    return { endpoint, profileDir: path.join(configuredHome, "chrome-cdp-profile"), started: false };
  }

  const executable = findChromeExecutable(options.executablePath);
  if (!executable) throw new Error("Google Chrome is not installed.");
  const profileDir = path.join(configuredHome, "chrome-cdp-profile");
  fs.mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  const child = spawn(
    executable,
    [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${profileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    { detached: true, stdio: "ignore" },
  );
  child.unref();

  const deadline = Date.now() + Math.max(Number(options.timeoutMs) || START_TIMEOUT_MS, 1_000);
  while (Date.now() < deadline) {
    if (await endpointReady(endpoint)) return { endpoint, profileDir, started: true };
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Google Chrome did not open its debugging endpoint at ${endpoint}.`);
}
