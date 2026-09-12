import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { COMMAND_SUMMARIES, helpFor } from "../../dist/src/cli-help.js";

test("MCP help lists batching, recording, and conditional credential tools", () => {
  const help = helpFor("mcp");
  for (const name of [
    "browser",
    "browser_batch",
    "browser_download",
    "browser_record",
    "browser_handoff",
    "browser_doctor",
    "browser_login",
  ]) {
    assert.match(help, new RegExp(`\\b${name}\\b`));
  }
  assert.match(help, /browser_login when the credential vault is enabled/);
  assert.match(help, /browser_batch runs guarded UI batches/);
  assert.match(help, /browser_record controls local video recording/);
});

// docs/cli.md is the published command reference; it must name every
// subcommand so a page that drifts behind cli-help.ts fails here, not in a
// user's hands. Flag coverage stays looser on purpose: only the flags that
// change behavior in ways a user cannot discover otherwise are pinned.
test("docs/cli.md covers every subcommand and the shared flag set", () => {
  const doc = readFileSync(new URL("../../docs/cli.md", import.meta.url), "utf8");
  for (const [name] of COMMAND_SUMMARIES) {
    assert.match(doc, new RegExp(`betterwright ${name}\\b`), `docs/cli.md is missing "${name}"`);
  }
  for (const flag of [
    "--session", "--profile", "--headed", "--headed-invisible", "--no-daemon",
    "--browser", "--browser-key", "--session-id", "--ad-block", "--no-ad-block",
    "--stealth", "--block-private-network", "--block-loopback", "--allow-host",
    "--block-host", "--no-launch-identity", "--upstream-proxy", "--geoip",
    "--locale", "--timezone", "--platform",
    "--approve-downloads", "--no-auto-ui", "--close", "--pretty",
    "--skip-browser", "--skip-agents",
  ]) {
    assert.ok(doc.includes(flag), `docs/cli.md is missing ${flag}`);
  }
});
