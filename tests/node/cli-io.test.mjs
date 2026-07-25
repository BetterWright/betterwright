import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  createInteractiveBrowserLifecycle,
  formatHangingText,
  makeLineReader,
  readExecTaskFromStdin,
} from "../../src/cli-io.mjs";

test("readExecTaskFromStdin preserves literal money and multiline content", () => {
  assert.equal(
    readExecTaskFromStdin(() => "find options under $4000\nand compare prices\n"),
    "find options under $4000\nand compare prices",
  );
  assert.equal(
    readExecTaskFromStdin(() => "keep the leading space and $4,000\r\n"),
    "keep the leading space and $4,000",
  );
});

test("interactive browser lifecycle starts once and rotates browser plus live view", async () => {
  const events = [];
  let nextId = 0;
  const lifecycle = createInteractiveBrowserLifecycle({
    createBrowser: () => {
      const id = ++nextId;
      return {
        id,
        close: async () => events.push(`close:${id}`),
      };
    },
    startBrowser: async (browser) => events.push(`live:${browser.id}`),
  });

  // The browser is created by start(), not at construction, so createBrowser
  // can be async (it loads the browser module on demand).
  assert.equal(lifecycle.browser, null);
  const first = await lifecycle.start();
  assert.equal(first.id, 1);
  assert.equal(lifecycle.browser, first);
  assert.deepEqual(events, ["live:1"]);

  const second = await lifecycle.replace();
  assert.equal(second.id, 2);
  assert.equal(lifecycle.browser, second);
  assert.deepEqual(events, ["live:1", "close:1", "live:2"]);

  await lifecycle.close();
  assert.deepEqual(events, ["live:1", "close:1", "live:2", "close:2"]);
});

test("formatHangingText wraps words with a stable continuation indent", () => {
  const prefix = "  · [12] browser: ";
  const formatted = formatHangingText(
    prefix,
    "I am comparing several gaming desktops before choosing the strongest value.",
    { columns: 48 },
  );
  const lines = formatted.split("\n");

  assert.ok(lines.length > 1);
  assert.ok(lines[0].startsWith(prefix));
  for (const line of lines.slice(1))
    assert.ok(line.startsWith(" ".repeat(prefix.length)));
  for (const line of lines) assert.ok(line.length < 48);
  assert.match(formatted, /strongest value\./);
});

test("formatHangingText preserves a label before an overlong first token", () => {
  const prefix = "  ▶ Watch live: ";
  const url =
    "http://127.0.0.1:41717/?t=SXtT3k9PVSN6kpTW_OnAeyNZGY4hgkKC";
  const lines = formatHangingText(prefix, url, { columns: 48 }).split("\n");

  assert.equal(lines[0], prefix.trimEnd());
  assert.ok(lines.slice(1).every((line) => line.startsWith(" ".repeat(prefix.length))));
  assert.equal(lines.join("").replaceAll(" ", ""), `${prefix}${url}`.replaceAll(" ", ""));
});

// A minimal readline stand-in: emits "line"/"close" and records prompts.
function fakeReadline() {
  const rl = new EventEmitter();
  rl.prompts = [];
  rl.setPrompt = (p) => rl.prompts.push(p);
  rl.prompt = () => {};
  return rl;
}

test("makeLineReader hands out lines in arrival order to awaiting callers", async () => {
  const rl = fakeReadline();
  const nextLine = makeLineReader(rl);
  const first = nextLine();
  const second = nextLine();
  rl.emit("line", "alpha");
  rl.emit("line", "beta");
  assert.equal(await first, "alpha");
  assert.equal(await second, "beta");
});

test("makeLineReader buffers a line typed while no one is waiting", async () => {
  const rl = fakeReadline();
  const nextLine = makeLineReader(rl);
  rl.emit("line", "early"); // arrives before any awaiter
  assert.equal(await nextLine(), "early");
});

test("makeLineReader capture routes steering while preserving commands and answers", async () => {
  const rl = fakeReadline();
  const nextLine = makeLineReader(rl);
  const captured = [];

  rl.emit("line", "pasted steering");
  const stop = nextLine.capture((line) => {
    if (line.startsWith("/")) return false;
    captured.push(line);
  });
  rl.emit("line", "use the cheaper option");
  rl.emit("line", "/new");
  assert.deepEqual(captured, ["pasted steering", "use the cheaper option"]);

  const answer = nextLine("answer ▸ ");
  rl.emit("line", "yes");
  assert.equal(await answer, "yes");
  assert.deepEqual(captured, ["pasted steering", "use the cheaper option"]);

  stop();
  assert.equal(await nextLine(), "/new");
  rl.emit("line", "next task");
  assert.equal(await nextLine(), "next task");
});

test("makeLineReader resolves null at close, for pending and future reads", async () => {
  const rl = fakeReadline();
  const nextLine = makeLineReader(rl);
  const pending = nextLine();
  rl.emit("close");
  assert.equal(await pending, null); // pending waiter drained
  assert.equal(await nextLine(), null); // and every read after close
});

test("makeLineReader renders a prompt only when it must wait", async () => {
  const rl = fakeReadline();
  const nextLine = makeLineReader(rl);
  rl.emit("line", "buffered");
  // A buffered line is returned without rendering a prompt.
  await nextLine("should-not-render ▸ ");
  assert.deepEqual(rl.prompts, []);
  // With nothing buffered, the prompt is set and rendered.
  const waiting = nextLine("ask ▸ ");
  assert.deepEqual(rl.prompts, ["ask ▸ "]);
  rl.emit("line", "answer");
  assert.equal(await waiting, "answer");
});
