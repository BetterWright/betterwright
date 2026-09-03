// Target resolution shared by the one-call batch surfaces: the AgentBatch
// executor (src/agent-batch.ts) and the guarded `controls.batch` transaction
// (src/ui-batch.ts). A target names exactly one element by aria ref, role,
// label, text, placeholder, test id, or CSS, optionally inside one iframe;
// resolution auto-waits like any Playwright locator and fails closed on
// ambiguity so a batch never acts on the wrong control.
//
// Parsing is separate from locating so a batch can be validated without a
// browser: `parseTarget` checks the fields, `locatorFor` binds the parsed
// target to a live page.

import { isBoolean, isNumber, isRecord, isString, type UntrustedValue, untrustedField } from "./untrusted-value.js";

export const TARGET_METHODS = ["ref", "role", "label", "text", "placeholder", "testId", "css"] as const;
export type TargetMethod = (typeof TARGET_METHODS)[number];
// Main-frame refs (`e12`) and frame-qualified refs (`f1e3`), with or without
// the `aria-ref=` selector prefix a model may copy from documentation.
const REF_PATTERN = /^(?:aria-ref=)?(?:f\d+)*e\d+$/;
const MAX_NTH = 99;
export const MAX_READ_TEXT_CHARS = 4_000;

/**
 * How a caller wants target errors worded: `subject` names the step or
 * operation (`AgentBatch step "q"`), `fields` prefixes field-type errors
 * (`AgentBatch`), so the two batch surfaces keep their own voice.
 */
export interface TargetLabels {
  subject: string;
  fields: string;
}

/** A validated target: one locating method plus its refinements. */
export interface ParsedTarget {
  method: TargetMethod;
  value: string;
  /** Accessible-name filter; `role` only. */
  name?: string;
  exact: boolean;
  nth?: number;
  frameName?: string;
  frameUrlIncludes?: string;
}

/** What one element reads as, with password values never included. */
export interface ElementReading {
  tag: string;
  text: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
}

export function boundedString(value: UntrustedValue, label: string, maximum: number) {
  if (!isString(value)) throw new TypeError(`${label} must be a string.`);
  const text = value.trim();
  if (!text) throw new TypeError(`${label} must not be empty.`);
  if (text.length > maximum) throw new RangeError(`${label} exceeds ${maximum} characters.`);
  return text;
}

const METHOD_LIMITS = {
  ref: { label: "ref", maximum: 64 },
  role: { label: "role", maximum: 64 },
  label: { label: "label", maximum: 500 },
  text: { label: "text", maximum: 500 },
  placeholder: { label: "placeholder", maximum: 500 },
  testId: { label: "test id", maximum: 500 },
  css: { label: "CSS", maximum: 2_000 },
} satisfies Record<TargetMethod, { label: string; maximum: number }>;

/**
 * Validate a target's fields. Exactly one targeting method is required;
 * `exact`, `nth`, and a frame scope refine it. Throws on a malformed target
 * so a typo fails before any page work.
 */
export function parseTarget(targetValue: UntrustedValue, labels: TargetLabels): ParsedTarget {
  if (!isRecord(targetValue)) {
    throw new TypeError(`${labels.subject} target must be an object.`);
  }
  const methods = TARGET_METHODS.filter((key) => untrustedField(targetValue, key) !== undefined);
  if (methods.length !== 1) {
    throw new Error(
      `${labels.subject} target must use exactly one of ref, role, label, text, placeholder, testId, or css.`,
    );
  }
  const method = methods[0];
  const limits = METHOD_LIMITS[method];
  const value = boundedString(untrustedField(targetValue, method), `${labels.fields} ${limits.label}`, limits.maximum);
  if (method === "ref" && !REF_PATTERN.test(value)) {
    throw new Error(`${labels.subject} has an invalid aria ref.`);
  }
  const exactValue = untrustedField(targetValue, "exact");
  if (exactValue !== undefined && !isBoolean(exactValue)) {
    throw new TypeError(`${labels.subject} target exact must be boolean.`);
  }
  const parsed: ParsedTarget = { method, value, exact: exactValue === true };
  const nameValue = untrustedField(targetValue, "name");
  if (nameValue !== undefined) {
    parsed.name = boundedString(nameValue, `${labels.fields} accessible name`, 500);
  }
  const nthValue = untrustedField(targetValue, "nth");
  if (nthValue !== undefined) {
    if (!isNumber(nthValue) || !Number.isInteger(nthValue) || nthValue < 0 || nthValue > MAX_NTH) {
      throw new RangeError(`${labels.subject} target nth must be an integer from 0 to ${MAX_NTH}.`);
    }
    parsed.nth = nthValue;
  }
  const frameUrlValue = untrustedField(targetValue, "frameUrlIncludes");
  const frameNameValue = untrustedField(targetValue, "frameName");
  if (frameUrlValue !== undefined && frameNameValue !== undefined) {
    throw new Error(`${labels.subject} target cannot combine frameUrlIncludes and frameName.`);
  }
  if (frameUrlValue !== undefined) {
    parsed.frameUrlIncludes = boundedString(frameUrlValue, `${labels.fields} frameUrlIncludes`, 1_000);
  }
  if (frameNameValue !== undefined) {
    parsed.frameName = boundedString(frameNameValue, `${labels.fields} frameName`, 500);
  }
  return parsed;
}

function frameRoot(page, target: ParsedTarget, labels: TargetLabels) {
  const { frameName, frameUrlIncludes } = target;
  if (frameName === undefined && frameUrlIncludes === undefined) return page;
  const frames = page.frames().filter((frame) =>
    (frameUrlIncludes !== undefined && frame.url().includes(frameUrlIncludes)) ||
    (frameName !== undefined && frame.name() === frameName));
  if (frames.length !== 1) {
    throw new Error(
      `${labels.subject} frame matched ${frames.length} frames; use a unique frame URL fragment or name.`,
    );
  }
  return frames[0];
}

/** Build the locator a parsed target describes on a live page, without waiting for it. */
export function locatorFor(page, target: ParsedTarget, labels: TargetLabels) {
  const root = frameRoot(page, target, labels);
  const { exact, value } = target;
  let locator;
  if (target.method === "ref") {
    locator = root.locator(value.startsWith("aria-ref=") ? value : `aria-ref=${value}`);
  } else if (target.method === "role") {
    const options: any = { exact };
    if (target.name !== undefined) options.name = target.name;
    locator = root.getByRole(value, options);
  } else if (target.method === "label") {
    locator = root.getByLabel(value, { exact });
  } else if (target.method === "text") {
    locator = root.getByText(value, { exact });
  } else if (target.method === "placeholder") {
    locator = root.getByPlaceholder(value, { exact });
  } else if (target.method === "testId") {
    locator = root.getByTestId(value);
  } else {
    locator = root.locator(value);
  }
  return target.nth === undefined ? locator : locator.nth(target.nth);
}

/** Parse a raw target and bind it to the page in one call. */
export function targetLocator(page, targetValue: UntrustedValue, labels: TargetLabels) {
  return locatorFor(page, parseTarget(targetValue, labels), labels);
}

/**
 * Resolve a locator to exactly one element. Role/text engines omit hidden
 * controls, so waiting for one match before enforcing uniqueness lets a
 * delayed result become visible while still refusing an ambiguous target
 * once it is actionable.
 */
export async function uniqueLocator(locator, labels: TargetLabels, timeout?: number) {
  await locator.first().waitFor(timeout === undefined ? { state: "attached" } : { state: "attached", timeout });
  const count = await locator.count();
  if (count !== 1) {
    throw new Error(
      `${labels.subject} target matched ${count} elements; use a more precise target or nth.`,
    );
  }
  return locator;
}

/** Whether the element is a password input, whose value must never be read. */
export function isPasswordField(locator): Promise<boolean> {
  return locator.evaluate((element) =>
    element instanceof HTMLInputElement && element.type.toLowerCase() === "password");
}

/** How long, and for what state, `readLocator` waits before reading. */
export interface ReadLocatorOptions {
  /** `visible` (the default) or `attached`, for reading hidden matches too. */
  state?: "visible" | "attached";
  timeout?: number;
}

/**
 * Read what an element shows: its tag, visible text, form value, checked and
 * disabled state, and aria-label. Password values are replaced with
 * "[redacted]" inside the page, so the secret never crosses into the worker.
 */
export async function readLocator(locator, options: ReadLocatorOptions = {}): Promise<ElementReading> {
  const waitFor: ReadLocatorOptions = { state: options.state ?? "visible" };
  if (options.timeout !== undefined) waitFor.timeout = options.timeout;
  await locator.waitFor(waitFor);
  return locator.evaluate((element, maxChars) => {
    const input = element instanceof HTMLInputElement ? element : null;
    const valueControl = element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement
      ? element
      : null;
    const disableable = valueControl || element instanceof HTMLButtonElement
      ? element
      : null;
    const text = element instanceof HTMLElement
      ? (element.innerText || element.textContent || "").trim()
      : (element.textContent || "").trim();
    return {
      tag: element.tagName.toLowerCase(),
      text: text.slice(0, maxChars),
      value: input?.type === "password"
        ? "[redacted]"
        : valueControl
          ? String(valueControl.value ?? "").slice(0, maxChars)
          : undefined,
      checked: input && ["checkbox", "radio"].includes(input.type) ? input.checked : undefined,
      disabled: disableable ? disableable.matches(":disabled") : undefined,
      ariaLabel: element.getAttribute("aria-label") || undefined,
    };
  }, MAX_READ_TEXT_CHARS);
}
