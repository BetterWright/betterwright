import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { startSessionDaemon } from "../../dist/src/daemon.js";
import { makeTempDir } from "./helpers/temp-dir.js";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("record CLI sends serialized options to the selected persistent session", async () => {
  const home = makeTempDir("bw-cli-record-");
  const calls = [];
  let browserClosed = false;
  const daemon = await startSessionDaemon({
    home,
    config: { profile: "record-test" },
    createBrowser: () => ({
      vault: false,
      async run(code, options) {
        calls.push({ code, options });
        return { ok: true, result: { state: "recording", fps: 60 } };
      },
      async close() { browserClosed = true; },
      async closeSession() { throw new Error("record must preserve the session"); },
    }),
    onExit: () => {},
    log: () => {},
  });
  try {
    for (const [args, expected] of [
      [["start", "--fps", "60", 'take"1.mp4', "--max-duration=2", "--max-width", "1280"],
        `return recording.start(${JSON.stringify({ name: 'take"1.mp4', fps: 60, maxWidth: 1280, maxDurationMs: 2000 })});`],
      [["status"], "return recording.status();"],
      [["stop"], "return recording.stop();"],
      [["restart", "second.webm"], 'return recording.restart({"name":"second.webm"});'],
    ] satisfies [string[], string][]) {
      const result = await execFileAsync(process.execPath, [
        path.join(root, "dist/bin/betterwright.js"), "record", ...args,
        "--profile", "record-test", "--session", "take",
      ], {
        cwd: root,
        timeout: 10_000,
        env: { ...process.env, BETTERWRIGHT_HOME: home, BETTERWRIGHT_NO_DAEMON: "0" },
      });
      const envelope = JSON.parse(result.stdout);
      assert.equal(envelope.ok, true);
      assert.equal(envelope.session, "take");
      assert.equal(calls.at(-1).code, expected);
      assert.equal(calls.at(-1).options.session, "take");
      assert.equal(browserClosed, false);
    }
  } finally {
    await daemon.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
