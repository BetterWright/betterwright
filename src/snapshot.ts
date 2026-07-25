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

// --- Snapshot compression --------------------------------------------------
//
// Playwright's `ariaSnapshot({mode: "ai"})` output keeps every named node,
// generic wrappers, `/url` property lines, and full-length names. Most of
// that structure carries no meaning for an agent, only tokens.
// `compressSnapshot` prunes it from the rendered YAML: parse the indent
// tree, transform, re-render. Lines that do not match the known grammar pass
// through untouched.

const NODE_CONTENT =
  /^([a-z]+(?:-[a-z]+)*)( "(?:[^"\\]|\\.)*")?((?: \[[^\][]*\])*)(:(?: (.*))?)?$/;
// Playwright single-quotes the whole key when the name makes it YAML-unsafe
// (e.g. contains ": "): `- 'link "feat: roll (" [ref=e3]':`.
const QUOTED_NODE_CONTENT = /^'((?:[^']|'')*)'(:(?: (.*))?)?$/;
const KEY_CONTENT = /^([a-z]+(?:-[a-z]+)*)( "(?:[^"\\]|\\.)*")?((?: \[[^\][]*\])*)$/;
const PROPERTY_CONTENT = /^\/([a-z]+): (.*)$/;

// Ported from Playwright's yaml.ts so re-rendered lines keep its format.
function yamlStringNeedsQuotes(str) {
  if (str.length === 0) return true;
  if (/^\s|\s$/.test(str)) return true;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: faithful port of Playwright's rule
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(str)) return true;
  if (/^-/.test(str)) return true;
  if (/[\n:](\s|$)/.test(str)) return true;
  if (/\s#/.test(str)) return true;
  if (/[\n\r]/.test(str)) return true;
  if (/^[&*\],?!>|@"'#%]/.test(str)) return true;
  if (/[{}`]/.test(str)) return true;
  if (/^\[/.test(str)) return true;
  if (
    !Number.isNaN(Number(str)) ||
    ["y", "n", "yes", "no", "true", "false", "on", "off", "null"].includes(
      str.toLowerCase(),
    )
  )
    return true;
  return false;
}

function yamlEscapeKeyIfNeeded(str) {
  if (!yamlStringNeedsQuotes(str)) return str;
  return `'${str.replace(/'/g, "''")}'`;
}

function yamlEscapeValueIfNeeded(str) {
  if (!yamlStringNeedsQuotes(str)) return str;
  return JSON.stringify(str);
}
// Roles whose refs never serve as action or scoping targets — a ref only
// earns its bytes on an element the model can act on or scope a read to.
// Refs survive on nodes with interaction or state markers ([cursor=pointer],
// [active], [expanded], …) — those are the div-buttons the model clicks.
const NO_REF_ROLES = new Set(["generic", "paragraph", "heading", "text", "img"]);
const NEUTRAL_ATTR = /^\[(?:ref=|box=|level=)/;
// Roles that are interactive by definition: `[cursor=pointer]` on them adds
// nothing.
const INHERENTLY_INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
  "spinbutton",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "treeitem",
  "listbox",
]);
const MAX_NAME_LENGTH = 100;

function parseSnapshotTree(text) {
  const root: any = { indent: -1, children: [] };
  const stack: any[] = [root];
  for (const line of String(text).split("\n")) {
    const lineMatch = /^(\s*)- (.*)$/.exec(line);
    const node: any = {
      indent: (lineMatch ? lineMatch[1] : /^\s*/.exec(line)[0]).length,
      raw: line,
      children: [],
    };
    if (lineMatch) {
      let content = lineMatch[2];
      const property = PROPERTY_CONTENT.exec(content);
      if (property) {
        node.kind = "prop";
        node.propName = property[1];
      } else {
        let value;
        const quoted = QUOTED_NODE_CONTENT.exec(content);
        if (quoted) {
          content = quoted[1].replace(/''/g, "'");
          value = quoted[3];
        }
        const key = quoted
          ? KEY_CONTENT.exec(content)
          : NODE_CONTENT.exec(content);
        if (key) {
          node.kind = "node";
          node.role = key[1];
          node.name = key[2] ? key[2].slice(1) : ""; // quoted, incl. quotes
          node.attrs = key[3] ? key[3].trim().split(/(?<=\]) /) : [];
          node.value = quoted ? value : key[5];
        }
      }
    }
    if (!node.kind) node.kind = "opaque";
    while (stack.length > 1 && stack[stack.length - 1].indent >= node.indent)
      stack.pop();
    stack[stack.length - 1].children.push(node);
    stack.push(node);
  }
  return root;
}

const isText = (node) =>
  node.kind === "node" &&
  node.role === "text" &&
  !node.attrs.length &&
  node.value !== undefined;

const isBareRole = (node, role) =>
  node.kind === "node" &&
  node.role === role &&
  !node.name &&
  node.attrs.every((attr) => /^\[(?:ref=|box=)/.test(attr));

function textNode(value) {
  return {
    kind: "node",
    role: "text",
    name: "",
    attrs: [],
    value,
    children: [],
  };
}

function truncateName(name) {
  // `name` is the raw quoted segment. Decode, cap, re-encode; leave the raw
  // segment alone if it is not valid JSON (defensive — it always should be).
  try {
    const decoded = JSON.parse(name);
    if (decoded.length <= MAX_NAME_LENGTH) return name;
    return JSON.stringify(`${decoded.slice(0, MAX_NAME_LENGTH - 1)}…`);
  } catch {
    return name;
  }
}

const stripWhitespace = (value) => value.replace(/\s+/g, "");
const unquote = (value) => {
  try {
    return typeof value === "string" && value.startsWith('"')
      ? JSON.parse(value)
      : value;
  } catch {
    return value;
  }
};
const sameText = (a, b) =>
  stripWhitespace(unquote(a ?? "")) === stripWhitespace(unquote(b ?? ""));
// Join text values, unquoting parts: `Milk` + `"2.49"` joins as `Milk 2.49`,
// then re-escapes only if the combined text needs it.
const joinTexts = (parts) => {
  const joined = parts.filter(Boolean).map(unquote).join(" ");
  return joined ? yamlEscapeValueIfNeeded(joined) : joined;
};

function compressNode(node, options) {
  const out = [];
  for (const child of node.children) {
    if (child.kind === "prop") {
      if (child.propName === "url" && !options.urls) continue;
      out.push(child);
      continue;
    }
    if (child.kind === "opaque") {
      compressNode(child, options);
      out.push(child);
      continue;
    }
    if (child.name) child.name = truncateName(child.name);
    if (INHERENTLY_INTERACTIVE_ROLES.has(child.role))
      child.attrs = child.attrs.filter((attr) => attr !== "[cursor=pointer]");
    if (
      NO_REF_ROLES.has(child.role) &&
      child.attrs.every((attr) => NEUTRAL_ATTR.test(attr))
    )
      child.attrs = child.attrs.filter((attr) => !attr.startsWith("[ref="));
    compressNode(child, options);
    // A nameless image carries no information at all.
    if (
      child.role === "img" &&
      !child.name &&
      child.value === undefined &&
      !child.children.length &&
      child.attrs.every((attr) => NEUTRAL_ATTR.test(attr))
    )
      continue;
    // Bare generic wrappers add a line and a level of indent but no
    // semantics: hoist their children (drop the node entirely when empty).
    if (isBareRole(child, "generic") && !child.value) {
      out.push(...child.children);
      continue;
    }
    // Bare paragraphs and generics that only carry text become text lines,
    // so adjacent ones can merge below.
    if (
      (isBareRole(child, "paragraph") || isBareRole(child, "generic")) &&
      child.children.every(isText)
    ) {
      const parts = child.children.map((textChild) => textChild.value);
      if (child.value !== undefined) parts.unshift(child.value);
      const merged = joinTexts(parts);
      if (merged) out.push(textNode(merged));
      continue;
    }
    out.push(child);
  }
  // Merge runs of adjacent text lines into one.
  const merged = [];
  for (const child of out) {
    const previous = merged[merged.length - 1];
    if (previous && isText(previous) && isText(child)) {
      previous.value = joinTexts([previous.value, child.value]);
      continue;
    }
    merged.push(child);
  }
  node.children = merged;
  if (node.kind !== "node") return;
  // Inline a sole text child as the node's value, exactly like Playwright
  // does when a node has no property lines.
  if (
    node.value === undefined &&
    node.children.length === 1 &&
    isText(node.children[0])
  ) {
    node.value = node.children[0].value;
    node.children = [];
  }
  // `button "Submit": Submit` says everything twice.
  if (node.name && node.value !== undefined && sameText(node.name, node.value))
    node.value = undefined;
  // A ref'd container whose 2-3 children are all plain text reads better,
  // and much shorter, as a single line.
  if (
    node.value === undefined &&
    node.attrs.some((attr) => attr.startsWith("[ref=")) &&
    node.children.length >= 2 &&
    node.children.length <= 3 &&
    node.children.every(isText)
  ) {
    const merged = joinTexts(node.children.map((child) => child.value));
    if (!node.name) {
      node.value = merged;
      node.children = [];
    } else if (sameText(node.name, merged)) {
      node.children = [];
    }
  }
}

function renderSnapshotNode(node, depth, lines) {
  if (node.kind === "opaque") {
    lines.push(node.raw);
  } else if (node.kind === "prop") {
    lines.push(`${"  ".repeat(depth)}- ${node.raw.trim().slice(2)}`);
  } else {
    const parts = [node.role];
    if (node.name) parts.push(node.name);
    parts.push(...node.attrs);
    let line = `${"  ".repeat(depth)}- ${yamlEscapeKeyIfNeeded(parts.join(" "))}`;
    if (node.value !== undefined) line += `: ${node.value}`;
    else if (node.children.length) line += ":";
    lines.push(line);
  }
  for (const child of node.children)
    renderSnapshotNode(child, depth + 1, lines);
}

/**
 * Shrink an `ariaSnapshot({mode: "ai"})` tree without losing anything
 * actionable: drop `/url` property lines (pass `{urls: true}` to keep them),
 * strip refs from non-actionable roles, unwrap bare `generic` wrappers, turn
 * text-only paragraphs into text lines, merge adjacent text, dedupe
 * name-equals-text, collapse text-only containers to one line, and cap
 * accessible names at 100 characters. Unrecognized lines pass through as-is.
 */
export function compressSnapshot(text, options: any = {}) {
  const root = parseSnapshotTree(text);
  compressNode(root, { urls: Boolean(options.urls) });
  const lines = [];
  for (const child of root.children) renderSnapshotNode(child, 0, lines);
  return lines.join("\n");
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
export function parseAnnotationBoxes(text, { max = 150 }: any = {}) {
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
