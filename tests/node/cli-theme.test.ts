// The theme's one contract: paint on a color TTY, byte-identical text
// everywhere else. Every stream/env combination is injected, so these tests
// never depend on how the test runner's own stdout is wired.

import assert from "node:assert/strict";
import test from "node:test";

import { cliPaint } from "../../dist/src/cli-theme.js";

const tty = { isTTY: true };
const pipe = { isTTY: false };

function paintOn(env = {}) {
  return cliPaint({ stream: tty, env: { TERM: "xterm-256color", ...env } });
}

test("a non-TTY stream, NO_COLOR, and TERM=dumb all disable color", () => {
  for (const paint of [
    cliPaint({ stream: pipe, env: {} }),
    cliPaint({ stream: tty, env: { NO_COLOR: "1" } }),
    cliPaint({ stream: tty, env: { TERM: "dumb" } }),
    cliPaint({ stream: tty, env: { NO_COLOR: "1", FORCE_COLOR: "0" } }),
  ]) {
    assert.equal(paint.on, false);
    const line = "  ✓ Default browser: Steel (steel), see `betterwright configure`";
    assert.equal(paint.status(line), line);
    assert.equal(paint.help("Usage: betterwright configure"), "Usage: betterwright configure");
    assert.equal(paint.accent("x"), "x");
  }
});

test("FORCE_COLOR turns color on even without a TTY", () => {
  const paint = cliPaint({ stream: pipe, env: { FORCE_COLOR: "1" } });
  assert.equal(paint.on, true);
  assert.equal(paint.accent("x"), "\x1b[38;5;208mx\x1b[0m");
});

test("COLORTERM=truecolor upgrades the orange to 24-bit", () => {
  const paint = paintOn({ COLORTERM: "truecolor" });
  assert.equal(paint.accent("x"), "\x1b[38;2;255;135;35mx\x1b[0m");
  assert.equal(paint.accentBold("x"), "\x1b[1;38;2;255;135;35mx\x1b[0m");
});

test("status lines color the glyph by meaning and leave the text alone", () => {
  const paint = paintOn();
  assert.equal(paint.status("  ✓ Node 22.1.0"), "  \x1b[38;5;208m✓\x1b[0m Node 22.1.0");
  assert.equal(paint.status("  ✗ broken"), "  \x1b[31m✗\x1b[0m broken");
  assert.equal(paint.status("  ! optional"), "  \x1b[33m!\x1b[0m optional");
  assert.equal(paint.status("      → betterwright setup"), "      \x1b[2m→\x1b[0m betterwright setup");
  // Only a leading glyph is a glyph; one mid-sentence is just a character.
  assert.equal(paint.status("fix the ✗ lines above"), "fix the ✗ lines above");
});

test("status lines accent backtick commands and menu numbers", () => {
  const paint = paintOn();
  assert.equal(
    paint.status("  run `betterwright doctor` again"),
    "  run `\x1b[38;5;208mbetterwright doctor\x1b[0m` again",
  );
  assert.equal(paint.status("   3) Steel (steel)"), "   \x1b[38;5;208m3)\x1b[0m Steel (steel)");
});

test("help text paints the wordmark, headings, flags, and command names", () => {
  const paint = paintOn();
  const painted = paint.help(
    [
      "betterwright — a persistent, policy-guarded browser for AI agents",
      "",
      "Usage: betterwright <command> [options]",
      "",
      "Commands:",
      "  configure  choose the browser backend: cloud provider, custom CDP, or managed",
      "",
      "Options:",
      "  --browser <value>      set the default",
      "",
      "Plain prose stays plain prose.",
    ].join("\n"),
  );
  const lines = painted.split("\n");
  assert.ok(lines[0].startsWith("\x1b[1;38;5;208mbetterwright\x1b[0m"), lines[0]);
  assert.equal(lines[2], "\x1b[2mUsage:\x1b[0m betterwright <command> [options]");
  assert.equal(lines[4], "\x1b[1mCommands:\x1b[0m");
  assert.ok(lines[5].startsWith("  \x1b[38;5;208mconfigure\x1b[0m  choose"), lines[5]);
  assert.equal(lines[8], "  \x1b[38;5;208m--browser\x1b[0m <value>      set the default");
  assert.equal(lines[10], "Plain prose stays plain prose.");
});
