import type { inspectActionDirectory } from "./page-inspect.js";
import { type UntrustedValue, untrustedField } from "./untrusted-value.js";

export const AUTOMATIC_UI_MAX_CHARS = 2_400;

// Suppress only a known duplicate, not arbitrary caller data: an extracted
// object may contain empty fields and still need actionable discovery context.
export function hasReturnedUIDirectory(result: UntrustedValue): boolean {
  const isDirectory = (value: UntrustedValue) =>
    untrustedField(value, "protocol") === "betterwright-ui/1" &&
    Array.isArray(untrustedField(value, "controls"));
  return isDirectory(result) || isDirectory(untrustedField(result, "ui"));
}

type ActionDirectory = Awaited<ReturnType<typeof inspectActionDirectory>>;

export function compactAutomaticUI(directory: ActionDirectory) {
  const compact: ActionDirectory & { hint: string } = {
    protocol: directory.protocol,
    tool: directory.tool,
    controls: [],
    evidence: [],
    truncated: directory.truncated,
    hint: "Call controls.directory() for the full directory.",
  };
  const fits = () => JSON.stringify(compact).length <= AUTOMATIC_UI_MAX_CHARS;
  // Reserve some space for observed state before the control list. Never cut a
  // target string: shortened labels and frame selectors are not valid handles.
  for (const entry of directory.evidence.slice(0, 2)) {
    compact.evidence.push(entry);
    if (!fits()) compact.evidence.pop();
  }
  if (compact.evidence.length < directory.evidence.length) compact.truncated = true;
  const actionButton = (entry) => entry.actions.includes("click") && entry.target.role !== "link";
  const ordered = [...directory.controls.filter(actionButton), ...directory.controls.filter((entry) => !actionButton(entry))];
  for (const entry of ordered) {
    const { options, ...control } = entry;

    // Keep small option lists when they fit: dropping every option forces
    // another discovery call before even a short form can be batched.
    compact.controls.push(entry);
    if (!fits()) {
      compact.controls[compact.controls.length - 1] = control;
      if (options) compact.truncated = true;
    }
    if (!fits()) {
      compact.controls.pop();
      compact.truncated = true;
    }
  }
  // Preserve DOM order in the public result after allocating the budget.
  compact.controls.sort((a, b) => directory.controls.findIndex((entry) => entry.target === a.target) - directory.controls.findIndex((entry) => entry.target === b.target));
  return compact;
}
