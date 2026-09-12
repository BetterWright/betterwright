import assert from "node:assert/strict";
import { test } from "node:test";
import { AUTOMATIC_UI_MAX_CHARS, compactAutomaticUI, hasReturnedUIDirectory } from "../../dist/src/automatic-ui.js";

test("automatic discovery suppresses only a returned UI directory", () => {
  for (const result of [null, true, 4, "ready", [], {}, { type: "Page", url: "https://example.com" },
    { type: "Response", status: 200 }, [{ type: "Locator", locator: "button" }], `https://example.com/${"a".repeat(500)}`]) {
    assert.equal(hasReturnedUIDirectory(result), false, JSON.stringify(result));
  }
  for (const result of [{ total: "$25.00" }, [{ name: "Stand", price: 12 }], { type: "product", name: "Stand" }, "page text\n".repeat(50)]) {
    assert.equal(hasReturnedUIDirectory(result), false);
  }
  assert.equal(hasReturnedUIDirectory({ protocol: "betterwright-ui/1", controls: [] }), true);
  assert.equal(hasReturnedUIDirectory({ protocol: "betterwright-ui/1" }), false);
  assert.equal(hasReturnedUIDirectory({ ui: { protocol: "betterwright-ui/1", controls: [] } }), true);
  assert.equal(hasReturnedUIDirectory({ ui: { controls: [] } }), false);
});

test("automatic UI has a hard budget without changing exact targets or the full directory", () => {
  const directory = {
    protocol: "betterwright-ui/1", tool: "browser_batch", truncated: false,
    controls: Array.from({ length: 40 }, (_, nth) => ({
      target: { label: `Product ${nth}`, exact: true, nth, frameName: "catalog" },
      actions: ["select", "read"],
      options: Array.from({ length: 20 }, (_, i) => ({ text: "Option ".repeat(12), value: String(i) })),
    })),
    evidence: [{ kind: "status", text: "Cart subtotal: $25.00" }],
  };
  const before = JSON.stringify(directory);
  const compact = compactAutomaticUI(directory);
  assert.ok(JSON.stringify(compact).length <= AUTOMATIC_UI_MAX_CHARS);
  assert.equal(compact.truncated, true);
  assert.ok(compact.controls.length > 0 && compact.controls.length < 40);
  for (const entry of compact.controls) {
    assert.deepEqual(entry.target, directory.controls[entry.target.nth].target);
    assert.equal(entry.options, undefined);
  }
  assert.deepEqual(compact.evidence, directory.evidence);
  assert.equal(JSON.stringify(directory), before);
});


test("automatic discovery keeps short select options for the next action batch", () => {
  const directory = {
    protocol: "betterwright-ui/1", tool: "browser_batch", truncated: false,
    controls: [{ target: { label: "Region", exact: true }, actions: ["select", "read"],
      options: [["North", "n", true], ["South", "s", false]] }],
    evidence: [],
  };
  const result = compactAutomaticUI(directory);
  assert.deepEqual(result.controls, directory.controls);
  assert.equal(result.truncated, false);
});
