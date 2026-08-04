import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { runLolcode, runLolcodeModule } from "../../dist/src/lolcode.js";

test("LOLCODE host calls can implement a BetterWright application operation", async () => {
  const calls: unknown[][] = [];
  const result = await runLolcode(
    [
      "HAI 1.2",
      "I HAS A answer ITZ host_call \"run\" AN \"return 42\" AN \"default\" MKAY",
      "FOUND YR answer",
      "KTHXBYE",
    ].join("\n"),
    {
      host: {
        host_call: (...args) => {
          calls.push(args);
          return "ok";
        },
      },
    },
  );

  assert.equal(result, "ok");
  assert.deepEqual(calls, [["run", "return 42", "default"]]);
});

test("the checked-in BetterWright API is valid LOLCODE", async () => {
  await assert.doesNotReject(() => runLolcodeModule("api", { host: { bw_host: () => "ok" } }));
});

test("the public CLI enters through LOLCODE before native command handling", () => {
  const version = execFileSync(process.execPath, ["dist/bin/betterwright.js", "--version"], {
    encoding: "utf8",
  }).trim();
  assert.match(version, /^\d+\.\d+\.\d+$/);
});
