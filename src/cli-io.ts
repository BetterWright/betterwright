// Small stdin helper for the interactive agent console (bin/betterwright.ts).
//
// One readline interface is shared by two readers: the console's top-level task
// prompt and the agent's `ask` tool. Both pull the *next* line from the same
// stream, so they must not each attach their own `line` listener and race. This
// serializes reads through a single queue: callers await `nextLine()`, lines are
// handed out in arrival order, and any line typed while no one is waiting is
// buffered for the next caller.

import fs from "node:fs";

import { isCallable, type UntrustedValue } from "./untrusted-value.js";

/**
 * Read an `exec` task from stdin without involving another shell parse.
 * Strip only the final line ending that pipes and heredocs conventionally add;
 * all task content, including dollar signs and internal newlines, stays literal.
 *
 * @param {() => string} read
 * @returns {string}
 */
export function readExecTaskFromStdin(read = () => fs.readFileSync(0, "utf8")) {
  return String(read()).replace(/\r?\n$/, "");
}

/**
 * Own the browser lifetime for the interactive console. A browser is started
 * once before the input loop, reused by every task, and atomically replaced by
 * commands such as `/new` that require a fresh browser + live-view session.
 *
 * `createBrowser` may be sync or async; it is awaited. The browser is created
 * by `start()` (not at construction), so `browser` is null until then — the
 * console starts the lifecycle before reading it.
 *
 * @param {{createBrowser: () => object | Promise<object>, startBrowser?: (browser: object) => Promise<void>}} options
 */
export function createInteractiveBrowserLifecycle({
  createBrowser,
  startBrowser = async () => {},
}: {
  createBrowser: () => any | Promise<any>;
  startBrowser?: (browser: any) => Promise<void>;
}) {
  let browser = null;
  return {
    get browser() {
      return browser;
    },
    async start() {
      browser = await createBrowser();
      await startBrowser(browser);
      return browser;
    },
    async replace() {
      if (browser) await browser.close();
      browser = await createBrowser();
      await startBrowser(browser);
      return browser;
    },
    async close() {
      if (browser) await browser.close();
    },
  };
}

/**
 * Wrap terminal output at word boundaries and align continuation lines beneath
 * the message body instead of letting the terminal snap them back to column 0.
 * Input must be plain text; add ANSI styling after this function returns.
 *
 * @param {string} prefix
 * @param {string} text
 * @param {{columns?: number}} [options]
 * @returns {string}
 */
export function formatHangingText(
  prefix,
  text,
  { columns = 80 } = {},
) {
  const firstPrefix = String(prefix || "");
  const continuation = " ".repeat(Array.from(firstPrefix).length);
  const width = Math.max(40, Math.floor(Number(columns) || 80)) - 1;
  const output = [];
  let firstLine = true;

  for (const paragraph of String(text ?? "").split(/\r?\n/)) {
    const words = paragraph.trim().split(/\s+/).filter(Boolean);
    let linePrefix = firstLine ? firstPrefix : continuation;
    firstLine = false;

    if (!words.length) {
      output.push(linePrefix.trimEnd());
      continue;
    }

    let line = linePrefix;
    let contentLength = 0;
    for (const word of words) {
      const characters = Array.from(word);
      const separator = contentLength ? 1 : 0;
      const available = width - Array.from(linePrefix).length - contentLength;
      if (separator + characters.length <= available) {
        line += `${separator ? " " : ""}${word}`;
        contentLength += separator + characters.length;
        continue;
      }

      if (contentLength) output.push(line);
      else if (linePrefix !== continuation)
        output.push(linePrefix.trimEnd());
      linePrefix = continuation;
      line = linePrefix;
      contentLength = 0;

      let remaining = characters;
      const chunkWidth = Math.max(1, width - continuation.length);
      while (remaining.length > chunkWidth) {
        output.push(`${continuation}${remaining.slice(0, chunkWidth).join("")}`);
        remaining = remaining.slice(chunkWidth);
      }
      line = `${continuation}${remaining.join("")}`;
      contentLength = remaining.length;
    }
    output.push(line);
  }

  return output.join("\n");
}

// The capture-handler contract documented on makeLineReader below; only
// callability is verified.
function isLineHandler(value: UntrustedValue): value is (line: string) => boolean | undefined {
  return isCallable(value);
}

/**
 * Wrap a readline interface in a serial line reader.
 * @param {import("node:readline").Interface} rl
 * @returns {((promptStr?: string) => Promise<string|null>) & {
 *   capture: (handler: (line: string) => boolean|void) => () => void
 * }} resolves with the next line, or `null` once the interface has closed
 *   (Ctrl-D / end of input). When a prompt string is given and no line is
 *   already buffered, readline renders it so line editing stays correct.
 *   `capture()` routes otherwise-unclaimed lines to a temporary handler; return
 *   `false` from that handler to keep a line queued for the next normal read.
 */
export function makeLineReader(rl) {
  const waiters = [];
  const buffered = [];
  const deferred = [];
  let closed = false;
  let capture = null;

  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else if (!capture) buffered.push(line);
    else if (capture(line) === false) deferred.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });

  const nextLine = (promptStr = "") => {
    if (buffered.length) return Promise.resolve(buffered.shift());
    if (closed) return Promise.resolve(null);
    if (promptStr) {
      rl.setPrompt(promptStr);
      rl.prompt();
    }
    return new Promise((resolve) => waiters.push(resolve));
  };
  nextLine.capture = (handler) => {
    capture = isLineHandler(handler) ? handler : null;
    if (capture && buffered.length) {
      const pending = buffered.splice(0, buffered.length);
      for (const line of pending)
        if (capture(line) === false) deferred.push(line);
    }
    return () => {
      if (capture === handler) {
        capture = null;
        buffered.push(...deferred.splice(0, deferred.length));
      }
    };
  };
  return nextLine;
}
