import assert from "node:assert/strict";
import test from "node:test";

import {
  obscuraServeArgs,
  parseLsofListeningPorts,
  parseNetstatListeningPorts,
  parseProcListeningPorts,
} from "../../dist/src/obscura-runtime.js";

test("Obscura stays loopback-only and behind BetterWright's guard proxy", () => {
  assert.deepEqual(
    obscuraServeArgs({
      port: 9123,
      storageDir: "/tmp/profile",
      proxy: "http://127.0.0.1:4567",
    }),
    [
      "serve",
      "--port",
      "9123",
      "--host",
      "127.0.0.1",
      "--storage-dir",
      "/tmp/profile",
      "--allow-private-network",
      "--stealth",
      "--proxy",
      "http://127.0.0.1:4567",
    ],
  );
});

test("Obscura's ephemeral listener is resolved only from the spawned process", () => {
  assert.deepEqual(
    parseLsofListeningPorts("p321\nf9\nn127.0.0.1:54321\nn*:9999\n"),
    [54321],
  );
  assert.deepEqual(
    parseNetstatListeningPorts(
      [
        "  TCP    127.0.0.1:54321    0.0.0.0:0    LISTENING    321",
        "  TCP    127.0.0.1:54322    0.0.0.0:0    LISTENING    999",
      ].join("\n"),
      321,
    ),
    [54321],
  );
  assert.deepEqual(
    parseProcListeningPorts(
      [
        "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
        "   0: 0100007F:D431 00000000:0000 0A 00000000:00000000 00:00000000 00000000  501 0 777",
        "   1: 0100007F:D432 00000000:0000 0A 00000000:00000000 00:00000000 00000000  501 0 888",
      ].join("\n"),
      new Set(["777"]),
    ),
    [54321],
  );
});
