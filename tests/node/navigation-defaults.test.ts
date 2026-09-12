import assert from "node:assert/strict";
import { test } from "node:test";
import { applyNavigationDefaults, navigationOptions } from "../../dist/src/navigation-defaults.js";

test("agent navigation defaults preserve explicit wait modes, timeouts and invalid options", () => {
  assert.deepEqual(navigationOptions(), { waitUntil: "domcontentloaded" });
  const supplied = { timeout: 150, referer: "https://example.com", waitUntil: undefined };
  assert.deepEqual(navigationOptions(supplied), { ...supplied, waitUntil: "domcontentloaded" });
  assert.equal(supplied.waitUntil, undefined);
  for (const waitUntil of ["load", "commit", "networkidle", null, "invalid"]) {
    assert.deepEqual(navigationOptions({ waitUntil, timeout: 150 }), { waitUntil, timeout: 150 });
  }
  for (const options of [null, false, "invalid"]) assert.equal(navigationOptions(options), options);
});

test("only navigation methods receive the new default", () => {
  for (const kind of ["Page", "Frame"]) {
    const args = ["https://example.com"];
    applyNavigationDefaults(kind, "goto", args);
    assert.deepEqual(args, ["https://example.com", { waitUntil: "domcontentloaded" }]);
  }
  for (const method of ["reload", "goBack", "goForward"]) {
    const args = [{ timeout: 150 }];
    applyNavigationDefaults("Page", method, args);
    assert.deepEqual(args, [{ timeout: 150, waitUntil: "domcontentloaded" }]);
  }
  for (const [kind, method] of [["Page", "waitForLoadState"], ["Page", "setContent"], ["Locator", "click"]]) {
    const args = ["load"];
    applyNavigationDefaults(kind, method, args);
    assert.deepEqual(args, ["load"]);
  }
});
