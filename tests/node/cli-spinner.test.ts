// The spinner's contract: animate only on a TTY, own exactly one line, and
// leave the stream byte-clean when cleared. Streams and paint are injected;
// mock timers drive the animation, so nothing here depends on wall-clock.

import assert from "node:assert/strict";
import test, { mock } from "node:test";

import {
  createSpinner,
  formatElapsed,
  phaseLabel,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
} from "../../dist/src/cli-spinner.js";
import { cliPaint } from "../../dist/src/cli-theme.js";

// Plain paint keeps the assertions readable; painting itself is the theme
// tests' job.
const plain = cliPaint({ stream: { isTTY: false }, env: {} });

function fakeStream(isTTY) {
  return {
    isTTY,
    writes: [],
    write(text) {
      this.writes.push(text);
      return true;
    },
  };
}

test("formatElapsed counts whole seconds, then minutes", () => {
  assert.equal(formatElapsed(0), "0s");
  assert.equal(formatElapsed(999), "0s");
  assert.equal(formatElapsed(7_400), "7s");
  assert.equal(formatElapsed(59_999), "59s");
  assert.equal(formatElapsed(60_000), "1m 00s");
  assert.equal(formatElapsed(125_000), "2m 05s");
  assert.equal(formatElapsed(-5), "0s");
});

test("phaseLabel names the wait after the phase and its first tool", () => {
  assert.equal(phaseLabel({ phase: "reasoning", step: 1 }), "reasoning");
  assert.equal(phaseLabel({ phase: "acting", tools: ["browser"] }), "browsing");
  assert.equal(phaseLabel({ phase: "acting", tools: ["login"] }), "logging in");
  assert.equal(phaseLabel({ phase: "acting", tools: ["handoff"] }), "waiting for your hands");
  assert.equal(phaseLabel({ phase: "acting", tools: ["done"] }), "finishing");
  // Unknown tools and malformed events still yield something sensible.
  assert.equal(phaseLabel({ phase: "acting", tools: ["mystery"] }), "working");
  assert.equal(phaseLabel({ phase: "acting" }), "working");
  assert.equal(phaseLabel(), "reasoning");
});

test("setLabel renames the wait and restarts its counter", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  try {
    const stream = fakeStream(true);
    const spinner = createSpinner({ stream, paint: plain, label: "reasoning" });
    spinner.start();
    mock.timers.tick(2000);
    assert.ok(stream.writes.at(-1).endsWith("reasoning · 2s"));

    spinner.setLabel("browsing");
    assert.ok(stream.writes.at(-1).endsWith("browsing · 0s"));
    // Same label again: no redundant redraw.
    const count = stream.writes.length;
    spinner.setLabel("browsing");
    assert.equal(stream.writes.length, count);
    spinner.stop();
  } finally {
    mock.timers.reset();
  }
});

test("every method is a no-op on a non-TTY stream", () => {
  const stream = fakeStream(false);
  const spinner = createSpinner({ stream, paint: plain });
  spinner.start();
  spinner.clear();
  spinner.stop();
  assert.deepEqual(stream.writes, []);
});

test("start paints the first frame at once; ticks advance frame and elapsed", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  try {
    const stream = fakeStream(true);
    const spinner = createSpinner({ stream, paint: plain });
    spinner.start();
    assert.deepEqual(stream.writes, [`\r\x1b[2K  ${SPINNER_FRAMES[0]} working · 0s`]);

    mock.timers.tick(SPINNER_INTERVAL_MS);
    assert.equal(stream.writes.at(-1), `\r\x1b[2K  ${SPINNER_FRAMES[1]} working · 0s`);

    // A second in, the counter has moved and the frame index matches the
    // number of renders so far (one per write).
    mock.timers.tick(1000);
    const frames = stream.writes.length - 1;
    assert.equal(
      stream.writes.at(-1),
      `\r\x1b[2K  ${SPINNER_FRAMES[frames % SPINNER_FRAMES.length]} working · 1s`,
    );
    spinner.stop();
  } finally {
    mock.timers.reset();
  }
});

test("clear erases the line once; stop erases and ends the animation", () => {
  mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 });
  try {
    const stream = fakeStream(true);
    const spinner = createSpinner({ stream, paint: plain, label: "thinking" });
    spinner.start();
    assert.ok(stream.writes.at(-1).endsWith("thinking · 0s"));

    spinner.clear();
    assert.equal(stream.writes.at(-1), "\r\x1b[2K");
    // Already cleared: a second clear writes nothing (step lines between
    // ticks must not stack erase sequences).
    spinner.clear();
    assert.equal(stream.writes.length, 2);

    // The next tick redraws below whatever line the caller printed.
    mock.timers.tick(SPINNER_INTERVAL_MS);
    assert.ok(stream.writes.at(-1).includes("thinking"));

    spinner.stop();
    assert.equal(stream.writes.at(-1), "\r\x1b[2K");
    const count = stream.writes.length;
    mock.timers.tick(SPINNER_INTERVAL_MS * 5);
    assert.equal(stream.writes.length, count);
  } finally {
    mock.timers.reset();
  }
});

test("a color paint accents the frame and dims the label", () => {
  const paint = cliPaint({ stream: { isTTY: true }, env: { TERM: "xterm-256color" } });
  const stream = fakeStream(true);
  const spinner = createSpinner({ stream, paint });
  spinner.start();
  assert.equal(
    stream.writes[0],
    `\r\x1b[2K  \x1b[38;5;208m${SPINNER_FRAMES[0]}\x1b[0m \x1b[2mworking · 0s\x1b[0m`,
  );
  spinner.stop();
});
