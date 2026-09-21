import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { navigateHistory } from "../../dist/src/navigation-defaults.js";

test("history waits for document readiness after commit rather than repeating BFCache lifecycle events", async () => {
  for (const method of ["goBack", "goForward"] as const) {
    for (const waitUntil of ["domcontentloaded", "load"]) {
      const calls = [];
      let disposed = false;
      const response = { status: 200 };
      const page = {
        async [method](options) { calls.push(options); return response; },
        async waitForFunction(predicate, state, options) {
          assert.equal(state, waitUntil);
          assert.ok(options.timeout > 0 && options.timeout <= 500);
          for (const [domContentLoadedEventEnd, loadEventEnd] of [[0, 0], [1, 0], [1, 2]]) {
            class PerformanceNavigationTiming {
              domContentLoadedEventEnd = domContentLoadedEventEnd;
              loadEventEnd = loadEventEnd;
            }
            const ready = vm.runInNewContext(`(${predicate.toString()})(state)`, {
              state,
              PerformanceNavigationTiming,
              performance: { getEntriesByType: () => [new PerformanceNavigationTiming()] },
              document: { readyState: "interactive" },
            });
            assert.equal(ready, waitUntil === "load" ? loadEventEnd > 0 : domContentLoadedEventEnd > 0);
          }
          return { async dispose() { disposed = true; } };
        },
      };
      const options = { waitUntil, timeout: 500 };
      assert.equal(await navigateHistory(page, method, options, 30_000), response);
      assert.deepEqual(calls, [{ waitUntil: "commit", timeout: 500 }]);
      assert.equal(options.waitUntil, waitUntil);
      assert.equal(disposed, true);
    }
  }
});

test("history preserves commit, networkidle, invalid options, and navigation failures", async () => {
  for (const options of [undefined, null, false, "invalid", { waitUntil: "commit" }, { waitUntil: "networkidle" }, { waitUntil: "invalid" }]) {
    const page = { async goBack(supplied) { assert.equal(supplied, options); return null; } };
    assert.equal(await navigateHistory(page, "goBack", options, 30_000), null);
  }
  const failure = new Error("navigation failed");
  await assert.rejects(navigateHistory({ async goBack() { throw failure; } }, "goBack", { waitUntil: "load" }, 30_000), failure);
});

test("history preserves disabled timeouts and propagates readiness failures", async () => {
  const page = {
    async goForward() { return null; },
    async waitForFunction(_predicate, _state, options) {
      assert.equal(options.timeout, 0);
      throw new Error("document readiness failed");
    },
  };
  await assert.rejects(navigateHistory(page, "goForward", { waitUntil: "load", timeout: 0 }, 30_000), /document readiness failed/);
});
