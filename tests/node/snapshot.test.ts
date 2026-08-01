import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compressSnapshot,
  diffSnapshots,
  filterInteractive,
  parseAnnotationBoxes,
} from "../../dist/src/snapshot.js";

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

test("compressSnapshot drops /url lines by default and keeps them on request", () => {
  const tree = [
    '- link "Docs" [ref=e2] [cursor=pointer]:',
    '  - /url: /docs',
  ].join("\n");
  assert.equal(compressSnapshot(tree), '- link "Docs" [ref=e2]');
  assert.equal(
    compressSnapshot(tree, { urls: true }),
    ['- link "Docs" [ref=e2]:', "  - /url: /docs"].join("\n"),
  );
});

test("compressSnapshot drops redundant cursor hints and nameless images", () => {
  const tree = [
    '- button "Go" [ref=e2] [cursor=pointer]',
    "- img [ref=e3]",
    '- img "Logo" [ref=e4]',
    "- img [ref=e5] [cursor=pointer]",
  ].join("\n");
  const compressed = compressSnapshot(tree);
  // Inherently interactive roles lose the hint; a clickable image keeps it
  // (and its ref); a named image survives without its useless ref.
  assert.equal(
    compressed,
    [
      '- button "Go" [ref=e2]',
      '- img "Logo"',
      "- img [ref=e5] [cursor=pointer]",
    ].join("\n"),
  );
});

test("compressSnapshot parses single-quoted keys without corrupting the tree", () => {
  const tree = [
    "- generic [ref=e1]:",
    `  - 'link "feat: roll to r1536 (" [ref=e3] [cursor=pointer]':`,
    '    - /url: /pull/1',
    '  - text: after',
  ].join("\n");
  assert.equal(
    compressSnapshot(tree),
    [`- 'link "feat: roll to r1536 (" [ref=e3]'`, "- text: after"].join("\n"),
  );
});

test("compressSnapshot keeps non-url property lines", () => {
  const tree = [
    '- textbox "Search" [ref=e2]:',
    '  - /placeholder: Type to search',
  ].join("\n");
  assert.equal(compressSnapshot(tree), tree);
});

test("compressSnapshot unwraps bare generic wrappers and hoists children", () => {
  const tree = [
    "- generic [ref=e1]:",
    "  - generic [ref=e2]:",
    '    - button "Go" [ref=e3]',
    "  - generic [ref=e4]",
  ].join("\n");
  assert.equal(compressSnapshot(tree), '- button "Go" [ref=e3]');
});

test("compressSnapshot keeps generics with interaction or state markers", () => {
  const tree = [
    "- generic [ref=e1] [cursor=pointer]:",
    '  - text: Open menu',
    "- generic [active] [ref=e2]:",
    '  - button "Save" [ref=e3]',
  ].join("\n");
  const compressed = compressSnapshot(tree);
  // The div-button keeps its ref (it is the click target) and inlines its text.
  assert.ok(
    compressed.includes("- generic [ref=e1] [cursor=pointer]: Open menu"),
  );
  assert.ok(compressed.includes("- generic [active] [ref=e2]:"));
});

test("compressSnapshot strips refs from non-actionable roles only", () => {
  const tree = [
    '- heading "Title" [level=1] [ref=e2]',
    '- paragraph [ref=e3]: Body text.',
    '- heading "Toggle" [level=2] [ref=e4] [cursor=pointer]',
    '- button "Go" [ref=e5]',
  ].join("\n");
  const compressed = compressSnapshot(tree);
  assert.ok(compressed.includes('- heading "Title" [level=1]\n'));
  assert.ok(compressed.includes("- text: Body text."));
  // Interactive heading keeps its ref; buttons always do.
  assert.ok(compressed.includes('- heading "Toggle" [level=2] [ref=e4] [cursor=pointer]'));
  assert.ok(compressed.includes('- button "Go" [ref=e5]'));
});

test("compressSnapshot merges paragraphs and adjacent text into text lines", () => {
  const tree = [
    "- article [ref=e1]:",
    "  - paragraph [ref=e2]: First sentence.",
    "  - paragraph [ref=e3]: Second sentence.",
    '  - text: Trailing note',
  ].join("\n");
  assert.equal(
    compressSnapshot(tree),
    "- article [ref=e1]: First sentence. Second sentence. Trailing note",
  );
});

test("compressSnapshot dedupes a value equal to the accessible name", () => {
  const tree = '- button "Submit" [ref=e2]: Submit';
  assert.equal(compressSnapshot(tree), '- button "Submit" [ref=e2]');
});

test("compressSnapshot collapses small text-only containers into one line", () => {
  const merged = compressSnapshot(
    [
      "- listitem [ref=e2]:",
      '  - text: Milk',
      '  - text: "2.49"',
    ].join("\n"),
  );
  assert.equal(merged, '- listitem [ref=e2]: Milk 2.49');
  // Four or more children stay structured.
  const big = [
    "- listitem [ref=e2]:",
    '  - heading "A" [level=3]',
    '  - text: b',
    '  - text: c',
  ].join("\n");
  assert.ok(compressSnapshot(big).includes('- heading "A" [level=3]'));
});

test("compressSnapshot truncates names over 100 characters", () => {
  const longName = "x".repeat(150);
  const compressed = compressSnapshot(`- button "${longName}" [ref=e2]`);
  assert.ok(compressed.includes(`"${"x".repeat(99)}…"`));
  assert.ok(!compressed.includes(longName));
});

test("compressSnapshot leaves unrecognized lines untouched", () => {
  const tree = [
    "- button [checked] [ref=e2]",
    "some stray line that is not a node",
    '- weird!role "x"',
  ].join("\n");
  const compressed = compressSnapshot(tree);
  assert.ok(compressed.includes("some stray line that is not a node"));
  assert.ok(compressed.includes('- weird!role "x"'));
});

test("compressSnapshot is idempotent", () => {
  const tree = [
    "- generic [ref=e1]:",
    "  - navigation [ref=e2]:",
    '    - link "Home" [ref=e3] [cursor=pointer]:',
    '      - /url: "#a"',
    "  - main [ref=e5]:",
    '    - heading "Title" [level=1] [ref=e6]',
    "    - paragraph [ref=e7]: Static text.",
    "    - generic [ref=e8]:",
    '      - textbox "Email" [ref=e9]',
    '      - button "Submit" [ref=e10]: Submit',
  ].join("\n");
  const once = compressSnapshot(tree);
  assert.equal(compressSnapshot(once), once);
});

test("compressSnapshot output stays consumable by filterInteractive", () => {
  const compressed = compressSnapshot(TREE);
  assert.ok(compressed.length < TREE.length);
  const filtered = filterInteractive(compressed);
  assert.ok(filtered.includes('link "Home"'));
  assert.ok(filtered.includes('textbox "Email"'));
  assert.ok(filtered.includes('button "Submit"'));
  assert.ok(!filtered.includes("Static text"));
});

test("compressSnapshot preserves iframe structure and frame refs", () => {
  const tree = [
    "- iframe [ref=e5]:",
    '  - button "Inner" [ref=f1e2]',
  ].join("\n");
  assert.equal(compressSnapshot(tree), tree);
});

test("diffSnapshots flags oversized inputs instead of stalling", () => {
  const big = Array.from({ length: 3_100 }, (_, i) => `- item ${i}`).join("\n");
  const result = diffSnapshots("- item x", big);
  assert.equal(result.changed, true);
  assert.equal(result.tooLarge, true);
});

// The diff table is the only allocation in this file that scales with the
// square of the input, so it grew a fast path (one-sided changes skip the
// table entirely) and line interning (integer compares in the inner loop).
// These pin the output against a straightforward reference so the
// optimizations cannot quietly change which lines are reported.

/**
 * The 1.6.0 implementation, verbatim: shared prefix/suffix trimming, a full
 * Uint32 table, and string comparisons in the inner loop. The optimized version
 * must agree with it line for line — including which side of an LCS tie it
 * picks, which the trimming step influences.
 */
function referenceDiff(previous, current) {
  if (previous === current) return { changed: false };
  let before = String(previous).split("\n");
  let after = String(current).split("\n");
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (
    endBefore > start &&
    endAfter > start &&
    before[endBefore - 1] === after[endAfter - 1]
  ) {
    endBefore -= 1;
    endAfter -= 1;
  }
  before = before.slice(start, endBefore);
  after = after.slice(start, endAfter);
  if (before.length > 3_000 || after.length > 3_000)
    return { changed: true, tooLarge: true };
  const cols = after.length + 1;
  const table = new Uint32Array((before.length + 1) * cols);
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        before[i] === after[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1]);
    }
  }
  const out = [];
  let additions = 0;
  let removals = 0;
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      i += 1;
      j += 1;
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      out.push(`- ${before[i]}`);
      removals += 1;
      i += 1;
    } else {
      out.push(`+ ${after[j]}`);
      additions += 1;
      j += 1;
    }
  }
  for (; i < before.length; i += 1) {
    out.push(`- ${before[i]}`);
    removals += 1;
  }
  for (; j < after.length; j += 1) {
    out.push(`+ ${after[j]}`);
    additions += 1;
  }
  return { changed: true, diff: out.join("\n"), additions, removals };
}

test("diffSnapshots still agrees line-for-line with the 1.6.0 algorithm", () => {
  // Deterministic PRNG: a failure here must be reproducible.
  let seed = 0x2f6e2b1;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  // A small alphabet makes repeated lines — and therefore interning
  // collisions and LCS ties — common rather than rare.
  const line = () => `- item ${Math.floor(random() * 6)}`;
  for (let round = 0; round < 200; round += 1) {
    const before = Array.from({ length: Math.floor(random() * 12) }, line);
    const after = before
      .filter(() => random() > 0.3)
      .flatMap((entry) => (random() > 0.75 ? [line(), entry] : [entry]));
    const previous = before.join("\n");
    const current = after.join("\n");
    assert.deepEqual(
      diffSnapshots(previous, current),
      referenceDiff(previous, current),
      `round ${round}: ${JSON.stringify({ previous, current })}`,
    );
  }
});

test("a purely one-sided change reports every line without building a table", () => {
  const before = ["- a", "- b", "- c"].join("\n");
  const after = ["- a", "- x", "- y", "- b", "- c"].join("\n");
  assert.deepEqual(diffSnapshots(before, after), referenceDiff(before, after));

  // Nothing in common at all: all removals, then all additions.
  const removedAll = diffSnapshots("- a\n- b", "- c\n- d");
  assert.deepEqual(removedAll, {
    changed: true,
    diff: "- - a\n- - b\n+ - c\n+ - d",
    additions: 2,
    removals: 2,
  });
});

test("a diff at the size cap stays within the halved table budget", () => {
  const before = Array.from({ length: 3_000 }, (_, i) => `- a${i}`).join("\n");
  const after = Array.from({ length: 3_000 }, (_, i) => `- b${i}`).join("\n");
  const result = diffSnapshots(before, after);
  assert.equal(result.changed, true);
  assert.equal(result.tooLarge, undefined);
  assert.equal(result.additions, 3_000);
  assert.equal(result.removals, 3_000);
});
