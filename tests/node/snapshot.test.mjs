import assert from "node:assert/strict";
import { test } from "node:test";

import {
  diffSnapshots,
  filterInteractive,
  parseAnnotationBoxes,
} from "../../src/snapshot.mjs";

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

const BOXED_TREE = [
  "- generic [ref=e1] [box=0,0,1200,900]:",
  '  - heading "Title" [level=1] [ref=e2] [box=10,10,300,40]',
  '  - button "Top" [ref=e3] [box=10,60,80,24]',
  '  - link "Away" [ref=e4] [cursor=pointer] [box=10,-30,80,24]:',
  '    - /url: "#a"',
  "  - iframe [ref=e5] [box=100,200,400,300]:",
  '    - button "Inner" [ref=f1e2] [box=8,8,120,24]',
  '    - iframe [ref=f1e3] [box=20,50,200,100]:',
  '      - button "Deep" [ref=f2e2] [box=5,5,60,20]',
  '  - button "Hidden" [ref=e6]',
  '  - button "Flat" [ref=e7] [box=10,500,80,0]',
].join("\n");

test("parseAnnotationBoxes keeps interactive elements with page-absolute boxes", () => {
  const boxes = parseAnnotationBoxes(BOXED_TREE);
  const byRef = Object.fromEntries(boxes.map((box) => [box.ref, box]));
  // Non-interactive, box-less, and zero-area elements are dropped.
  assert.ok(!byRef.e2, "heading should be dropped");
  assert.ok(!byRef.e6, "element without a box should be dropped");
  assert.ok(!byRef.e7, "zero-height element should be dropped");
  // Main-frame boxes pass through unchanged, negatives included.
  assert.deepEqual(byRef.e3, { ref: "e3", x: 10, y: 60, width: 80, height: 24 });
  assert.equal(byRef.e4.y, -30);
  // cursor=pointer counts as interactive.
  assert.ok(byRef.e4);
  // Child-frame boxes are offset by every ancestor iframe.
  assert.deepEqual(byRef.f1e2, {
    ref: "f1e2",
    x: 108,
    y: 208,
    width: 120,
    height: 24,
  });
  assert.deepEqual(byRef.f2e2, {
    ref: "f2e2",
    x: 125,
    y: 255,
    width: 60,
    height: 20,
  });
});

test("parseAnnotationBoxes caps output without corrupting iframe offsets", () => {
  const lines = ["- generic [ref=e1] [box=0,0,1000,1000]:"];
  for (let i = 0; i < 10; i += 1)
    lines.push(`  - button "b${i}" [ref=e${i + 2}] [box=0,${i * 30},50,20]`);
  const boxes = parseAnnotationBoxes(lines.join("\n"), { max: 3 });
  assert.equal(boxes.length, 3);
  assert.equal(boxes[0].ref, "e2");
});

test("diffSnapshots flags oversized inputs instead of stalling", () => {
  const big = Array.from({ length: 3_100 }, (_, i) => `- item ${i}`).join("\n");
  const result = diffSnapshots("- item x", big);
  assert.equal(result.changed, true);
  assert.equal(result.tooLarge, true);
});
