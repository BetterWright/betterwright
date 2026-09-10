import assert from "node:assert/strict";
import test from "node:test";

import { helpFor } from "../../dist/src/cli-help.js";

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
