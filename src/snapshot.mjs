// Pure text transforms for aria snapshots (mode: "ai"). Kept free of
// Playwright imports so they can be unit-tested without a browser.

// Roles an agent can act on. Mirrors the set agent-browser refs, minus
// container roles that only matter with a name (covered by cursor=pointer).
const INTERACTIVE_ROLE = new RegExp(
  "^\\s*- (?:button|link|textbox|searchbox|combobox|checkbox|radio|switch|" +
    "slider|spinbutton|menuitem(?:checkbox|radio)?|option|tab|treeitem|" +
    "listbox|iframe)\\b",
);

function indentOf(line) {
  let count = 0;
  while (line[count] === " ") count += 1;
  return count;
}

/**
 * Reduce an aria snapshot to interactive elements plus the ancestor lines
 * needed to keep the tree readable. Property lines (`- /url: …`) survive when
 * their element does.
 */
export function filterInteractive(text) {
  const lines = String(text).split("\n");
  const keep = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isProperty = /^\s*- \//.test(line);
    if (
      isProperty ||
      !(INTERACTIVE_ROLE.test(line) || line.includes("[cursor=pointer]"))
    )
      continue;
    keep[i] = true;
    let indent = indentOf(line);
    // Walk up the tree keeping each ancestor once.
    for (let j = i - 1; j >= 0 && indent > 0; j -= 1) {
      const parentIndent = indentOf(lines[j]);
      if (parentIndent < indent) {
        keep[j] = true;
        indent = parentIndent;
      }
    }
    // Keep property lines nested directly under this element.
    for (let j = i + 1; j < lines.length; j += 1) {
      if (!/^\s*- \//.test(lines[j]) || indentOf(lines[j]) <= indentOf(line))
        break;
      keep[j] = true;
    }
  }
  const kept = lines.filter((_, i) => keep[i]);
  return kept.length ? kept.join("\n") : "(no interactive elements)";
}

const REF_PATTERN = /\[ref=([a-z0-9]+)\]/;
const BOX_PATTERN =
  /\[box=(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)\]/;
const IFRAME_LINE = /^\s*- iframe\b/;

/**
 * Extract interactive elements with page-absolute bounding boxes from an
 * `ariaSnapshot({mode: "ai", boxes: true})` tree. Child-frame boxes are
 * reported relative to their own frame's viewport, so each element's box is
 * offset by the boxes of its ancestor iframes (tracked via indentation).
 * Returns up to `max` entries of `{ref, x, y, width, height}`.
 */
export function parseAnnotationBoxes(text, { max = 150 } = {}) {
  const stack = [{ indent: -1, dx: 0, dy: 0 }];
  const boxes = [];
  for (const line of String(text).split("\n")) {
    if (/^\s*- \//.test(line)) continue; // property line, e.g. `- /url: …`
    const boxMatch = BOX_PATTERN.exec(line);
    if (!boxMatch) continue;
    const indent = indentOf(line);
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent)
      stack.pop();
    const { dx, dy } = stack[stack.length - 1];
    const box = {
      x: Number(boxMatch[1]) + dx,
      y: Number(boxMatch[2]) + dy,
      width: Number(boxMatch[3]),
      height: Number(boxMatch[4]),
    };
    if (IFRAME_LINE.test(line))
      stack.push({ indent, dx: box.x, dy: box.y });
    if (boxes.length >= max) continue;
    const ref = REF_PATTERN.exec(line)?.[1];
    if (!ref || box.width <= 0 || box.height <= 0) continue;
    if (!(INTERACTIVE_ROLE.test(line) || line.includes("[cursor=pointer]")))
      continue;
    boxes.push({ ref, ...box });
  }
  return boxes;
}

// Beyond this many lines per side an LCS table stops being cheap; callers
// fall back to the full snapshot.
const MAX_DIFF_LINES = 3_000;

/**
 * Line diff between two snapshots. Returns `{changed: false}` when equal,
 * `{changed: true, diff, additions, removals}` with only `+`/`-` lines
 * otherwise, or `{tooLarge: true}` when either side exceeds MAX_DIFF_LINES.
 */
export function diffSnapshots(previous, current) {
  if (previous === current) return { changed: false };
  let before = String(previous).split("\n");
  let after = String(current).split("\n");
  // Trim the common prefix and suffix so the LCS table only covers the
  // changed region.
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
  if (before.length > MAX_DIFF_LINES || after.length > MAX_DIFF_LINES)
    return { changed: true, tooLarge: true };

  // Longest-common-subsequence table over the changed region.
  const rows = before.length + 1;
  const cols = after.length + 1;
  const table = new Uint32Array(rows * cols);
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
