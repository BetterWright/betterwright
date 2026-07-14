import assert from "node:assert/strict";
import test from "node:test";

import { BetterWright } from "../../src/client.mjs";

test("fillCredential rejects a missing passwordSelector without starting a worker", async () => {
  const bw = new BetterWright();
  const result = await bw.fillCredential({ usernameSelector: "#u" });
  assert.equal(result.ok, false);
  assert.match(result.error, /passwordSelector/);
  await bw.close();
});

test("fillCredential also rejects a blank passwordSelector", async () => {
  const bw = new BetterWright();
  const result = await bw.fillCredential({ passwordSelector: "   " });
  assert.equal(result.ok, false);
  assert.match(result.error, /passwordSelector/);
  await bw.close();
});
