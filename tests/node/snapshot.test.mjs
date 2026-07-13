import assert from "node:assert/strict";
import { test } from "node:test";

import { diffSnapshots, filterInteractive } from "../../src/snapshot.mjs";

const TREE = [
  '- generic [active] [ref=e1]:',
  '  - navigation [ref=e2]:',
  '    - link "Home" [ref=e3] [cursor=pointer]:',
  '      - /url: "#a"',
  '  - main [ref=e5]:',
  '    - heading "Title" [level=1] [ref=e6]',
  '    - paragraph [ref=e7]: Static text.',
  '    - generic [ref=e8]:',
  '      - textbox "Email" [ref=e9]',
  '      - button "Submit" [ref=e10]',
].join("\n");

test("filterInteractive keeps actionable elements and their ancestors", () => {
  const filtered = filterInteractive(TREE);
  assert.ok(filtered.includes('link "Home"'));
  assert.ok(filtered.includes('- /url: "#a"'));
  assert.ok(filtered.includes('textbox "Email"'));
  assert.ok(filtered.includes('button "Submit"'));
  // Ancestors survive so the tree stays readable.
  assert.ok(filtered.includes("navigation [ref=e2]"));
  assert.ok(filtered.includes("main [ref=e5]"));
  // Non-interactive content is dropped.
  assert.ok(!filtered.includes("heading"));
  assert.ok(!filtered.includes("Static text"));
});

test("filterInteractive reports pages with nothing to click", () => {
  const filtered = filterInteractive('- heading "Only text" [ref=e1]');
  assert.equal(filtered, "(no interactive elements)");
});

test("diffSnapshots detects no change", () => {
  assert.deepEqual(diffSnapshots(TREE, TREE), { changed: false });
});

test("diffSnapshots returns only changed lines", () => {
  const after = TREE.replace(
    '      - button "Submit" [ref=e10]',
    '      - button "Sending…" [disabled] [ref=e10]\n      - alert [ref=e11]: Sent!',
  );
  const result = diffSnapshots(TREE, after);
  assert.equal(result.changed, true);
  assert.equal(result.additions, 2);
  assert.equal(result.removals, 1);
  const lines = result.diff.split("\n");
  assert.equal(lines.length, 3);
  assert.ok(lines.includes('- ' + '      - button "Submit" [ref=e10]'));
  assert.ok(
    lines.includes('+ ' + '      - button "Sending…" [disabled] [ref=e10]'),
  );
});

test("diffSnapshots flags oversized inputs instead of stalling", () => {
  const big = Array.from({ length: 3_100 }, (_, i) => `- item ${i}`).join("\n");
  const result = diffSnapshots("- item x", big);
  assert.equal(result.changed, true);
  assert.equal(result.tooLarge, true);
});
