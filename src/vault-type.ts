// `vault type` — send a secret as keystrokes into the focused window.
//
// Clipboard paste is the usual owner path (`vault copy`), but some surfaces
// swallow it: Proxmox noVNC, a few VNC/SPICE consoles, some remote-desktop
// clients. The person then has to type a generated password by hand. This
// command types into whichever window has focus after a short countdown.
//
// The secret is piped on stdin (or, on macOS, embedded in an AppleScript that
// itself arrives on stdin). It must never appear in argv — `ps` and shell
// history would keep a copy. spawn is injectable so tests can exercise every
// platform's argv/stdin contract without a keystroke tool running (which
// would type a test secret into whatever happens to be focused).

import { spawn } from "node:child_process";

export const DEFAULT_TYPE_DELAY_SECONDS = 5;
export const DEFAULT_KEY_DELAY_MS = 25;

export function parseTypeDelaySeconds(value, fallback = DEFAULT_TYPE_DELAY_SECONDS) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 120) {
    throw new Error("--delay must be a number of seconds between 0 and 120.");
  }
  return parsed;
}

export function parseKeyDelayMs(value, fallback = DEFAULT_KEY_DELAY_MS) {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1000) {
    throw new Error("--key-delay must be milliseconds between 0 and 1000.");
  }
  return parsed;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Pipe `text` to a child on stdin and never on argv. stdio[1]/[2] are ignored
 * so a chatty tool cannot echo the secret back into a captured terminal.
 */
export function spawnWithStdin(spawnFn, command, args, text) {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const child = spawnFn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
    // Spawn errors (ENOENT, EACCES) mean the process never started, so a
    // later candidate is safe to try. A close with a non-zero code means
    // the tool ran — it may already have typed — and is tagged `started`.
    child.once("error", (error) => {
      error.started = false;
      finish(reject, error);
    });
    child.once("close", (code) => {
      if (code === 0) {
        finish(resolve, undefined);
        return;
      }
      const error: any = new Error(`${command} exited ${code}`);
      error.started = true;
      error.exitCode = code;
      finish(reject, error);
    });
    // SAFETY: the child is spawned with stdio[0] = "pipe" just above, so
    // stdin is always a writable stream, never null. Ignore EPIPE: a tool
    // that exits before reading still reports through close/error, and an
    // unhandled stdin error would crash the CLI with the secret in a dump.
    const stdin = child.stdin as NonNullable<typeof child.stdin>;
    stdin.on("error", () => {});
    stdin.end(text);
  });
}

function escapeAppleScriptString(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

/**
 * AppleScript that types `text` via System Events. The script (and therefore
 * the secret) is meant to be fed on osascript's stdin, not `-e`.
 */
export function appleScriptForType(text, keyDelayMs = DEFAULT_KEY_DELAY_MS) {
  const delaySec = Math.max(0, Number(keyDelayMs) || 0) / 1000;
  const escaped = escapeAppleScriptString(text);
  // A single keystroke is enough when there is no inter-key delay and no
  // character System Events will not take as a one-shot string.
  if (delaySec === 0 && !/[\r\n\t]/.test(text)) {
    return `tell application "System Events" to keystroke "${escaped}"`;
  }
  return [
    'tell application "System Events"',
    `  set theDelay to ${delaySec}`,
    `  set theText to "${escaped}"`,
    "  repeat with c in characters of theText",
    "    set ch to contents of c",
    "    if ch is return or ch is linefeed then",
    "      keystroke return",
    "    else if ch is tab then",
    "      keystroke tab",
    "    else",
    "      keystroke ch",
    "    end if",
    "    if theDelay > 0 then delay theDelay",
    "  end repeat",
    "end tell",
  ].join("\n");
}

/**
 * PowerShell that reads the secret from stdin and injects Unicode via
 * SendInput. Encoded as UTF-16LE base64 so the script can be passed as
 * `-EncodedCommand` without a shell-quoting maze, and without the secret
 * being part of that script.
 */
export function windowsTypeEncodedCommand(keyDelayMs = DEFAULT_KEY_DELAY_MS) {
  const delay = Math.max(0, Math.round(Number(keyDelayMs) || 0));
  const script = [
    "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false",
    "$sig = @'",
    "using System;",
    "using System.Runtime.InteropServices;",
    "public static class BetterWrightType {",
    "  [StructLayout(LayoutKind.Sequential)]",
    "  public struct INPUT {",
    "    public uint type;",
    "    public InputUnion u;",
    "  }",
    "  [StructLayout(LayoutKind.Explicit)]",
    "  public struct InputUnion {",
    "    [FieldOffset(0)] public MOUSEINPUT mi;",
    "    [FieldOffset(0)] public KEYBDINPUT ki;",
    "  }",
    "  [StructLayout(LayoutKind.Sequential)]",
    "  public struct MOUSEINPUT {",
    "    public int dx;",
    "    public int dy;",
    "    public uint mouseData;",
    "    public uint dwFlags;",
    "    public uint time;",
    "    public IntPtr dwExtraInfo;",
    "  }",
    "  [StructLayout(LayoutKind.Sequential)]",
    "  public struct KEYBDINPUT {",
    "    public ushort wVk;",
    "    public ushort wScan;",
    "    public uint dwFlags;",
    "    public uint time;",
    "    public IntPtr dwExtraInfo;",
    "  }",
    "  const uint INPUT_KEYBOARD = 1;",
    "  const uint KEYEVENTF_KEYUP = 2;",
    "  const uint KEYEVENTF_UNICODE = 4;",
    "  const ushort VK_TAB = 0x09;",
    "  const ushort VK_RETURN = 0x0D;",
    "  [DllImport(\"user32.dll\", SetLastError = true)]",
    "  static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);",
    "  static INPUT Key(ushort vk, ushort scan, uint flags) {",
    "    INPUT i = new INPUT();",
    "    i.type = INPUT_KEYBOARD;",
    "    i.u.ki.wVk = vk;",
    "    i.u.ki.wScan = scan;",
    "    i.u.ki.dwFlags = flags;",
    "    return i;",
    "  }",
    "  public static void TypeText(string text, int delayMs) {",
    "    int size = Marshal.SizeOf(typeof(INPUT));",
    "    foreach (char c in text) {",
    "      INPUT[] pair = new INPUT[2];",
    "      if (c == '\\n' || c == '\\r') {",
    "        pair[0] = Key(VK_RETURN, 0, 0);",
    "        pair[1] = Key(VK_RETURN, 0, KEYEVENTF_KEYUP);",
    "      } else if (c == '\\t') {",
    "        pair[0] = Key(VK_TAB, 0, 0);",
    "        pair[1] = Key(VK_TAB, 0, KEYEVENTF_KEYUP);",
    "      } else {",
    "        pair[0] = Key(0, c, KEYEVENTF_UNICODE);",
    "        pair[1] = Key(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);",
    "      }",
    "      SendInput(2, pair, size);",
    "      if (delayMs > 0) System.Threading.Thread.Sleep(delayMs);",
    "    }",
    "  }",
    "}",
    "'@",
    "Add-Type -TypeDefinition $sig -Language CSharp",
    "$raw = [Console]::In.ReadToEnd()",
    `[BetterWrightType]::TypeText($raw, ${delay})`,
  ].join("\n");
  return Buffer.from(script, "utf16le").toString("base64");
}

export function typeToolCandidates(platform, keyDelayMs = DEFAULT_KEY_DELAY_MS) {
  const delayMs = Math.max(0, Math.round(Number(keyDelayMs) || 0));
  const delay = String(delayMs);
  if (platform === "darwin") return [["osascript", []]];
  if (platform === "win32") {
    const encoded = windowsTypeEncodedCommand(delayMs);
    const args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
    return [
      ["powershell", args],
      ["pwsh", args],
    ];
  }
  return [
    ["wtype", ["-d", delay, "-"]],
    // Older ydotool treats `--file -` as a literal filename; /dev/stdin is
    // the same stream and works on those builds too.
    ["ydotool", ["type", "--key-delay", delay, "--file", "/dev/stdin"]],
    ["xdotool", ["type", "--clearmodifiers", "--delay", delay, "--file", "-"]],
  ];
}

function stdinPayload(command, text, keyDelayMs) {
  return command === "osascript" ? appleScriptForType(text, keyDelayMs) : text;
}

function noToolError(platform, tried, lastError) {
  const last = lastError ? `; last error: ${lastError.message}` : "";
  const prefix = `No keystroke tool worked (tried ${tried}${last}). `;
  if (platform === "linux") {
    return `${prefix}Install wtype, ydotool, or xdotool, or use \`vault copy\` / \`vault show <id> --reveal\`.`;
  }
  if (platform === "darwin") {
    return (
      `${prefix}Grant this terminal Accessibility access for System Events, ` +
      "or use `vault copy` / `vault show <id> --reveal`."
    );
  }
  return `${prefix}Use \`vault copy\` or \`vault show <id> --reveal\` instead.`;
}

export async function typeIntoFocusedWindow(
  text,
  { platform = process.platform, spawn: spawnFn = spawn, keyDelayMs = DEFAULT_KEY_DELAY_MS } = {},
) {
  const candidates = typeToolCandidates(platform, keyDelayMs);
  let lastError = null;
  for (const [command, args] of candidates) {
    try {
      await spawnWithStdin(spawnFn, command, args, stdinPayload(command, text, keyDelayMs));
      return { ok: true, tool: command };
    } catch (error) {
      lastError = error;
      // A tool that started may have already typed part of the secret.
      // Falling through would duplicate it in the focused field.
      if (error?.started) {
        return {
          ok: false,
          error:
            `${error.message}. Not trying another keystroke tool — this one may have already typed. ` +
            "Use `vault copy` or `vault show <id> --reveal` if the field is empty.",
        };
      }
    }
  }
  return {
    ok: false,
    error: noToolError(
      platform,
      candidates.map(([command]) => command).join(", "),
      lastError,
    ),
  };
}
