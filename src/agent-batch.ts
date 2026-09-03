// AgentBatch — the default two-call way for an agent to drive the browser.
//
// Call one opens a page and returns its spec: an interactive snapshot whose
// `[ref=eN]` markers, roles, and names are the targets the model plans with.
// Call two sends every step the task needs. The worker runs them back to back
// with Playwright auto-waiting and no pacing between actions, then returns one
// compact result: what each step produced, which step failed (if any), and a
// fresh observation of where the page ended up — so the next call can resume
// from the failing step instead of re-observing and re-planning from scratch.
//
// This module is pure orchestration. `normalizeAgentBatch` is synchronous and
// browser-free, so every surface (JS API, MCP, Pi, the built-in agent, the
// CLI) can reject a malformed batch before a worker round trip and unit tests
// need no browser. `executeAgentBatch` drives a Playwright page through an
// injected host that supplies the worker-owned helpers a batch may not reach
// on its own: snapshots, screenshots, page switching, dialog arming, and the
// navigation policy check every model-supplied URL must pass.

import { setTimeout as hostDelay } from "node:timers/promises";

import {
  boundedString,
  type ElementReading,
  isPasswordField,
  locatorFor,
  type ParsedTarget,
  parseTarget,
  readLocator,
  type TargetLabels,
  uniqueLocator,
} from "./batch-targets.js";
import {
  isBoolean,
  isNumber,
  isRecord,
  isString,
  parsedUrl,
  type UntrustedValue,
  untrustedField,
} from "./untrusted-value.js";

export const AGENT_BATCH_PROTOCOL = "agent-batch/1";
export const MAX_AGENT_BATCH_STEPS = 100;
const MAX_JSON_CHARS = 256_000;
const MAX_TEXT_CHARS = 10_000;
const MAX_URL_CHARS = 4_000;
const MAX_KEY_CHARS = 100;
const MAX_ATTRIBUTE_CHARS = 100;
const MAX_SELECT_VALUES = 50;
const MAX_READ_ALL = 100;
const MAX_WAIT_MS = 10_000;
const MAX_SCROLL_DELTA = 20_000;
const DEFAULT_STEP_TIMEOUT_MS = 10_000;
const MIN_STEP_TIMEOUT_MS = 100;
const MAX_STEP_TIMEOUT_MS = 60_000;
const DEFAULT_SETTLE_MS = 1_000;
const MAX_SETTLE_MS = 5_000;
const MAX_PACING_MS = 1_000;
const MAX_ERROR_CHARS = 600;
const POLL_MS = 50;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export const AGENT_BATCH_ACTIONS = [
  "goto",
  "back",
  "forward",
  "reload",
  "click",
  "dblclick",
  "hover",
  "fill",
  "type",
  "press",
  "select",
  "check",
  "uncheck",
  "scroll",
  "wait",
  "read",
  "url",
  "snapshot",
  "screenshot",
  "openPage",
  "usePage",
  "closePage",
  "dialog",
  "overlays",
] as const;

export type AgentBatchAction = (typeof AGENT_BATCH_ACTIONS)[number];
export type AgentBatchObserve = "snapshot" | "diff" | "none";
export type AgentBatchWaitUntil = "load" | "domcontentloaded" | "commit" | "networkidle";
export type AgentBatchWaitState = "attached" | "detached" | "visible" | "hidden";
export type AgentBatchDialogResponse = "accept" | "dismiss";

const ACTIONS = new Set<string>(AGENT_BATCH_ACTIONS);
// Steps that change site state; the batch must carry allowWrites for them.
const WRITE_ACTIONS = new Set<AgentBatchAction>([
  "click",
  "dblclick",
  "fill",
  "type",
  "press",
  "select",
  "check",
  "uncheck",
  "dialog",
  "overlays",
]);
// Steps after which the page may still be changing, so the next observation
// first lets in-flight document/fetch/XHR requests finish.
const UNSETTLING_ACTIONS = new Set<AgentBatchAction>([
  ...WRITE_ACTIONS,
  "goto",
  "back",
  "forward",
  "reload",
  "openPage",
  "usePage",
]);
const OBSERVING_ACTIONS = new Set<AgentBatchAction>(["read", "url", "snapshot", "screenshot"]);
const TARGET_ACTIONS = new Set<AgentBatchAction>([
  "click",
  "dblclick",
  "hover",
  "fill",
  "type",
  "select",
  "check",
  "uncheck",
  "read",
]);
const WAIT_UNTIL = new Set<string>(["load", "domcontentloaded", "commit", "networkidle"]);
const WAIT_STATES = new Set<string>(["attached", "detached", "visible", "hidden"]);
const DIALOG_RESPONSES = new Set<string>(["accept", "dismiss"]);
const OBSERVE_MODES = new Set<string>(["snapshot", "diff", "none"]);
const SCREENSHOT_KINDS = new Set<string>(["proof", "question", "debug"]);
const COMMON_FIELDS = ["id", "action", "optional", "irreversible", "timeoutMs"];
// Every field each action understands. Unknown fields are rejected so a typo
// (`selector` for `css`, `text` on a fill) fails before the browser moves.
const ACTION_FIELDS = {
  goto: ["url", "waitUntil"],
  back: [],
  forward: [],
  reload: ["waitUntil"],
  click: ["target"],
  dblclick: ["target"],
  hover: ["target"],
  fill: ["target", "value"],
  type: ["target", "value", "append"],
  press: ["key", "target"],
  select: ["target", "value"],
  check: ["target"],
  uncheck: ["target"],
  scroll: ["target", "dx", "dy"],
  wait: ["target", "state", "url", "text", "ms"],
  read: ["target", "attribute", "all", "expect"],
  url: ["expect"],
  snapshot: ["interactive", "ref", "selector", "diff", "depth", "maxChars", "urls"],
  screenshot: ["kind", "name", "fullPage", "annotate"],
  openPage: ["url"],
  usePage: ["page"],
  closePage: ["page"],
  dialog: ["response", "promptText"],
  overlays: [],
} satisfies Record<AgentBatchAction, string[]>;

/** One validated step of a plan, ready for the executor. */
export interface AgentBatchStep {
  id: string;
  action: AgentBatchAction;
  optional: boolean;
  irreversible: boolean;
  /** Explicit per-step budget; unset means Playwright's action/navigation default. */
  timeoutMs?: number;
  target?: ParsedTarget;
  url?: string;
  waitUntil?: AgentBatchWaitUntil;
  value?: string;
  values?: string[];
  append?: boolean;
  key?: string;
  dx?: number;
  dy?: number;
  state?: AgentBatchWaitState;
  text?: string;
  ms?: number;
  attribute?: string;
  all?: boolean;
  expect?: string;
  snapshot?: AgentBatchSnapshotOptions;
  screenshot?: AgentBatchScreenshotOptions;
  page?: string | number;
  response?: AgentBatchDialogResponse;
  promptText?: string;
}

export interface AgentBatchSnapshotOptions {
  interactive: boolean;
  ref?: string;
  selector?: string;
  diff?: boolean;
  depth?: number;
  maxChars?: number;
  urls?: boolean;
}

export interface AgentBatchScreenshotOptions {
  kind: string;
  name?: string;
  fullPage?: boolean;
  annotate?: boolean;
}

export interface AgentBatchPlanOptions {
  allowWrites: boolean;
  allowIrreversible: boolean;
  allowPasswords: boolean;
  observe: AgentBatchObserve;
  proof: boolean;
  settleMs: number;
  minIntervalMs: number;
}

export interface AgentBatchPlan {
  steps: AgentBatchStep[];
  options: AgentBatchPlanOptions;
}

/** A screenshot the host captured, as the worker records artifacts. */
export interface AgentBatchArtifact {
  kind: string;
  path: string;
  media: string;
}

export interface AgentBatchPageInfo {
  id: string;
  url: string;
  title: string;
}

export interface AgentBatchReading extends ElementReading {
  attribute?: string | null;
}

/** The result of one step: `ok` plus whatever the action produced. */
export interface AgentBatchStepResult extends Partial<AgentBatchReading> {
  id: string;
  action: AgentBatchAction;
  ok: boolean;
  error?: string;
  url?: string;
  title?: string;
  status?: number;
  filled?: number;
  typed?: number;
  pressed?: string;
  selected?: string[];
  scrolled?: string | { dx: number; dy: number };
  waited?: string;
  ms?: number;
  count?: number;
  items?: AgentBatchReading[];
  snapshot?: string;
  screenshot?: AgentBatchArtifact;
  pageId?: string;
  closed?: boolean;
  prepared?: AgentBatchDialogResponse;
  dismissed?: Array<{ kind: string; label: string }>;
}

export interface AgentBatchFailure {
  index: number;
  id: string;
  action: AgentBatchAction;
  error: string;
}

export interface AgentBatchResult {
  protocol: typeof AGENT_BATCH_PROTOCOL;
  /** Every non-optional step succeeded. */
  ok: boolean;
  /** Steps that succeeded; `failed.index` is where a stopped batch should resume. */
  completed: number;
  total: number;
  failed?: AgentBatchFailure;
  steps: AgentBatchStepResult[];
  page: AgentBatchPageInfo;
  snapshot?: string;
  observeError?: string;
  proof?: AgentBatchArtifact;
  durationMs: number;
}

/**
 * What the worker lends the executor. Every method operates on the session
 * the batch runs in; `currentPage` is consulted before each step because
 * page steps and popups can change which page is current mid-batch.
 */
export interface AgentBatchHost {
  currentPage(): Promise<any>;
  pageId(page): string;
  snapshot(options: AgentBatchSnapshotOptions): Promise<string>;
  screenshot(options: AgentBatchScreenshotOptions): Promise<AgentBatchArtifact>;
  assertNavigationUrl(url: string): void;
  openPage(url?: string): Promise<any>;
  usePage(selector: string | number): Promise<any>;
  closePage(selector?: string | number): Promise<{ closed: boolean; pageId?: string }>;
  dismissOverlays(page): Promise<{ dismissed: Array<{ kind: string; label: string }> }>;
  armDialog(response: AgentBatchDialogResponse, promptText?: string): void;
  /** The batch observed this page's spec, so the envelope can skip the redundant `ui` directory. */
  observed?(page): void;
}

// --- Validation --------------------------------------------------------------

function cloneJson(value: UntrustedValue, label: string) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} must be JSON-serializable: ${error?.message || error}`);
  }
  if (encoded === undefined || encoded.length > MAX_JSON_CHARS) {
    throw new RangeError(`${label} exceeds its ${MAX_JSON_CHARS}-character limit.`);
  }
  return JSON.parse(encoded);
}

function boundedInteger(value: UntrustedValue, label: string, minimum: number, maximum: number) {
  if (!isNumber(value) || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function optionalBoolean(value: UntrustedValue, label: string) {
  if (value !== undefined && !isBoolean(value)) throw new TypeError(`${label} must be boolean.`);
  return value === true;
}

function optionalText(value: UntrustedValue, label: string, maximum: number) {
  return value === undefined ? undefined : boundedString(value, label, maximum);
}

function enumValue<T extends string>(value: UntrustedValue, label: string, allowed: Set<string>): T {
  if (!isString(value) || !allowed.has(value)) {
    throw new Error(`${label} must be one of ${[...allowed].join(", ")}.`);
  }
  // SAFETY: membership in `allowed` was just checked; T is the union of
  // exactly those literals at every call site.
  return value as T;
}

function stepLabel(id: string) {
  return `AgentBatch step ${JSON.stringify(id)}`;
}

function targetLabels(id: string): TargetLabels {
  return { subject: stepLabel(id), fields: "AgentBatch" };
}

function normalizeOptions(value: UntrustedValue): AgentBatchPlanOptions {
  if (value !== undefined && !isRecord(value)) throw new TypeError("AgentBatch options must be an object.");
  const observeValue = untrustedField(value, "observe");
  const settleValue = untrustedField(value, "settleMs");
  const pacingValue = untrustedField(value, "minIntervalMs");
  return {
    allowWrites: optionalBoolean(untrustedField(value, "allowWrites"), "AgentBatch allowWrites"),
    allowIrreversible: optionalBoolean(untrustedField(value, "allowIrreversible"), "AgentBatch allowIrreversible"),
    allowPasswords: optionalBoolean(untrustedField(value, "allowPasswords"), "AgentBatch allowPasswords"),
    observe: observeValue === undefined
      ? "snapshot"
      : enumValue<AgentBatchObserve>(observeValue, "AgentBatch observe", OBSERVE_MODES),
    proof: optionalBoolean(untrustedField(value, "proof"), "AgentBatch proof"),
    settleMs: settleValue === undefined
      ? DEFAULT_SETTLE_MS
      : boundedInteger(settleValue, "AgentBatch settleMs", 0, MAX_SETTLE_MS),
    minIntervalMs: pacingValue === undefined
      ? 0
      : boundedInteger(pacingValue, "AgentBatch minIntervalMs", 0, MAX_PACING_MS),
  };
}

function normalizeSnapshotOptions(value: UntrustedValue, label: string): AgentBatchSnapshotOptions {
  const interactiveValue = untrustedField(value, "interactive");
  if (interactiveValue !== undefined && !isBoolean(interactiveValue)) {
    throw new TypeError(`${label} interactive must be boolean.`);
  }
  const options: AgentBatchSnapshotOptions = { interactive: interactiveValue !== false };
  const ref = optionalText(untrustedField(value, "ref"), `${label} ref`, 64);
  if (ref !== undefined) options.ref = ref;
  const selector = optionalText(untrustedField(value, "selector"), `${label} selector`, 2_000);
  if (selector !== undefined) options.selector = selector;
  const diff = untrustedField(value, "diff");
  if (diff !== undefined) options.diff = optionalBoolean(diff, `${label} diff`);
  const depth = untrustedField(value, "depth");
  if (depth !== undefined) options.depth = boundedInteger(depth, `${label} depth`, 1, 100);
  const maxChars = untrustedField(value, "maxChars");
  if (maxChars !== undefined) options.maxChars = boundedInteger(maxChars, `${label} maxChars`, 1_000, 20_000);
  const urls = untrustedField(value, "urls");
  if (urls !== undefined) options.urls = optionalBoolean(urls, `${label} urls`);
  return options;
}

function normalizeScreenshotOptions(value: UntrustedValue, label: string): AgentBatchScreenshotOptions {
  const kindValue = untrustedField(value, "kind");
  const options: AgentBatchScreenshotOptions = {
    kind: kindValue === undefined ? "debug" : enumValue<string>(kindValue, `${label} kind`, SCREENSHOT_KINDS),
  };
  const name = optionalText(untrustedField(value, "name"), `${label} name`, 200);
  if (name !== undefined) options.name = name;
  const fullPage = untrustedField(value, "fullPage");
  if (fullPage !== undefined) options.fullPage = optionalBoolean(fullPage, `${label} fullPage`);
  const annotate = untrustedField(value, "annotate");
  if (annotate !== undefined) options.annotate = optionalBoolean(annotate, `${label} annotate`);
  return options;
}

function pageSelector(value: UntrustedValue, label: string) {
  if (isNumber(value)) return boundedInteger(value, label, 0, 999);
  return boundedString(value, label, 64);
}

function normalizeStep(value: UntrustedValue, index: number, ids: Set<string>, options: AgentBatchPlanOptions): AgentBatchStep {
  const position = `AgentBatch step ${index + 1}`;
  if (!isRecord(value)) throw new TypeError(`${position} must be an object.`);
  const idValue = untrustedField(value, "id");
  const id = idValue === undefined ? `s${index + 1}` : boundedString(idValue, `${position} id`, 64);
  if (!ID_PATTERN.test(id)) throw new Error(`${position} has an invalid id.`);
  if (ids.has(id)) throw new Error(`AgentBatch step id ${JSON.stringify(id)} is duplicated.`);
  ids.add(id);
  const label = stepLabel(id);
  const actionValue = untrustedField(value, "action");
  if (!isString(actionValue) || !ACTIONS.has(actionValue)) {
    throw new Error(
      `${label} has unsupported action ${JSON.stringify(actionValue)}; use one of ${AGENT_BATCH_ACTIONS.join(", ")}.`,
    );
  }
  // SAFETY: membership in ACTIONS, the set built from AGENT_BATCH_ACTIONS,
  // was checked on the line above.
  const action = actionValue as AgentBatchAction;
  const allowed = new Set([...COMMON_FIELDS, ...ACTION_FIELDS[action]]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${label} (${action}) does not accept ${JSON.stringify(key)}; allowed: ${[...allowed].join(", ")}.`);
    }
  }
  const optional = optionalBoolean(untrustedField(value, "optional"), `${label} optional`);
  const irreversible = optionalBoolean(untrustedField(value, "irreversible"), `${label} irreversible`);
  if (WRITE_ACTIONS.has(action) && !options.allowWrites) {
    throw new Error(`${label} (${action}) changes page state; pass allowWrites:true only when authorized.`);
  }
  if (irreversible && !options.allowIrreversible) {
    throw new Error(`${label} is marked irreversible; pass allowIrreversible:true only after required confirmation.`);
  }
  const step: AgentBatchStep = { id, action, optional, irreversible };
  const timeoutValue = untrustedField(value, "timeoutMs");
  if (timeoutValue !== undefined) {
    step.timeoutMs = boundedInteger(timeoutValue, `${label} timeoutMs`, MIN_STEP_TIMEOUT_MS, MAX_STEP_TIMEOUT_MS);
  }
  const target = untrustedField(value, "target");
  if (TARGET_ACTIONS.has(action) && target === undefined) {
    throw new TypeError(`${label} (${action}) requires a target.`);
  }
  if (target !== undefined) step.target = parseTarget(target, targetLabels(id));
  const rawValue = untrustedField(value, "value");
  switch (action) {
    case "goto":
    case "openPage": {
      const url = untrustedField(value, "url");
      if (action === "goto" || url !== undefined) {
        step.url = boundedString(url, `${label} url`, MAX_URL_CHARS);
        // Syntax only; the scheme and search-policy checks belong to the
        // worker's navigation gate, which every URL still passes at run time.
        if (!parsedUrl(step.url)) throw new TypeError(`${label} url must be an absolute URL.`);
      }
      break;
    }
    case "fill":
    case "type":
      if (!isString(rawValue) || rawValue.length > MAX_TEXT_CHARS) {
        throw new TypeError(`${label} value must be a string of at most ${MAX_TEXT_CHARS} characters.`);
      }
      step.value = rawValue;
      if (action === "type") step.append = optionalBoolean(untrustedField(value, "append"), `${label} append`);
      break;
    case "press":
      step.key = boundedString(untrustedField(value, "key"), `${label} key`, MAX_KEY_CHARS);
      break;
    case "select": {
      const values = Array.isArray(rawValue) ? rawValue : [rawValue];
      const strings = values.filter((entry) => isString(entry) && entry.length > 0 && entry.length <= 500);
      if (!values.length || values.length > MAX_SELECT_VALUES || strings.length !== values.length) {
        throw new TypeError(`${label} value must be a string or a bounded string array.`);
      }
      step.values = strings;
      break;
    }
    case "scroll": {
      const dx = untrustedField(value, "dx");
      const dy = untrustedField(value, "dy");
      if (target === undefined) {
        step.dx = dx === undefined ? 0 : boundedInteger(dx, `${label} dx`, -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA);
        step.dy = dy === undefined ? 0 : boundedInteger(dy, `${label} dy`, -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA);
        if (!step.dx && !step.dy) throw new Error(`${label} scroll needs a target or a non-zero dx/dy.`);
      } else if (dx !== undefined || dy !== undefined) {
        throw new Error(`${label} scroll takes either a target or dx/dy, not both.`);
      }
      break;
    }
    case "wait": {
      const conditions = ["target", "url", "text", "ms"].filter((key) => untrustedField(value, key) !== undefined);
      if (conditions.length !== 1) {
        throw new Error(`${label} wait needs exactly one of target, url, text, or ms.`);
      }
      const stateValue = untrustedField(value, "state");
      if (stateValue !== undefined && target === undefined) {
        throw new Error(`${label} wait state applies only with a target.`);
      }
      if (target !== undefined) {
        step.state = stateValue === undefined
          ? "visible"
          : enumValue<AgentBatchWaitState>(stateValue, `${label} state`, WAIT_STATES);
      }
      const url = optionalText(untrustedField(value, "url"), `${label} url`, MAX_URL_CHARS);
      if (url !== undefined) step.url = url;
      const text = optionalText(untrustedField(value, "text"), `${label} text`, 500);
      if (text !== undefined) step.text = text;
      const ms = untrustedField(value, "ms");
      if (ms !== undefined) step.ms = boundedInteger(ms, `${label} ms`, 0, MAX_WAIT_MS);
      break;
    }
    case "read": {
      const attribute = optionalText(untrustedField(value, "attribute"), `${label} attribute`, MAX_ATTRIBUTE_CHARS);
      if (attribute !== undefined) step.attribute = attribute;
      step.all = optionalBoolean(untrustedField(value, "all"), `${label} all`);
      const expect = optionalText(untrustedField(value, "expect"), `${label} expect`, MAX_TEXT_CHARS);
      if (expect !== undefined) {
        if (step.all) throw new Error(`${label} read cannot combine all and expect.`);
        step.expect = expect;
      }
      break;
    }
    case "url": {
      const expect = optionalText(untrustedField(value, "expect"), `${label} expect`, MAX_URL_CHARS);
      if (expect !== undefined) step.expect = expect;
      break;
    }
    case "snapshot":
      step.snapshot = normalizeSnapshotOptions(value, label);
      break;
    case "screenshot":
      step.screenshot = normalizeScreenshotOptions(value, label);
      break;
    case "usePage":
      step.page = pageSelector(untrustedField(value, "page"), `${label} page`);
      break;
    case "closePage": {
      const page = untrustedField(value, "page");
      if (page !== undefined) step.page = pageSelector(page, `${label} page`);
      break;
    }
    case "dialog": {
      step.response = enumValue<AgentBatchDialogResponse>(
        untrustedField(value, "response"),
        `${label} response`,
        DIALOG_RESPONSES,
      );
      const promptText = optionalText(untrustedField(value, "promptText"), `${label} promptText`, MAX_TEXT_CHARS);
      if (promptText !== undefined) step.promptText = promptText;
      break;
    }
    default:
      break;
  }
  if (action === "goto" || action === "reload") {
    const waitUntil = untrustedField(value, "waitUntil");
    if (waitUntil !== undefined) {
      step.waitUntil = enumValue<AgentBatchWaitUntil>(waitUntil, `${label} waitUntil`, WAIT_UNTIL);
    }
  }
  return step;
}

/**
 * Validate a batch and its options into a plan. Throws a TypeError, RangeError,
 * or Error naming the offending step and field; never touches a browser.
 */
export function normalizeAgentBatch(stepsValue: UntrustedValue, optionsValue?: UntrustedValue): AgentBatchPlan {
  if (!Array.isArray(stepsValue) || !stepsValue.length) {
    throw new TypeError("AgentBatch steps must be a non-empty array.");
  }
  if (stepsValue.length > MAX_AGENT_BATCH_STEPS) {
    throw new RangeError(`AgentBatch accepts at most ${MAX_AGENT_BATCH_STEPS} steps.`);
  }
  cloneJson(stepsValue, "AgentBatch steps");
  const options = normalizeOptions(optionsValue);
  const ids = new Set<string>();
  const steps = stepsValue.map((value, index) => normalizeStep(value, index, ids, options));
  return { steps, options };
}

// --- Snippet generation ------------------------------------------------------

/** JSON that is also a valid JavaScript literal inside a snippet. */
function encodeJson(value: UntrustedValue) {
  return JSON.stringify(value)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const OPTION_FIELDS = [
  "allowWrites",
  "allowIrreversible",
  "allowPasswords",
  "observe",
  "proof",
  "settleMs",
  "minIntervalMs",
];

/**
 * Tool arguments every surface accepts: a URL to open, or the steps to run,
 * plus the batch options. Surfaces pass their whole argument object; fields
 * they add for themselves (`session`, `note`) are ignored here.
 */
export interface AgentBatchToolArgs {
  url?: UntrustedValue;
  steps?: UntrustedValue;
  allowWrites?: UntrustedValue;
  allowIrreversible?: UntrustedValue;
  allowPasswords?: UntrustedValue;
  observe?: UntrustedValue;
  proof?: UntrustedValue;
  settleMs?: UntrustedValue;
  minIntervalMs?: UntrustedValue;
}

/**
 * Turn tool arguments into the browser snippet that runs the batch. `{url}`
 * alone is the spec call — sugar for one `goto` step followed by the default
 * observation. Validation runs here so a malformed batch is refused before
 * the worker round trip, with the same message the worker would give.
 */
export function agentBatchCode(args: AgentBatchToolArgs) {
  const url = args.url === undefined ? "" : String(args.url).trim();
  if (url && args.steps !== undefined) {
    throw new TypeError("AgentBatch accepts either url or steps, not both.");
  }
  if (!url && args.steps === undefined) {
    throw new TypeError("AgentBatch requires url or a non-empty steps array.");
  }
  const steps = url ? [{ action: "goto", url }] : args.steps;
  const options: Record<string, UntrustedValue> = {};
  for (const key of OPTION_FIELDS) {
    const value = untrustedField(args, key);
    if (value !== undefined) options[key] = value;
  }
  normalizeAgentBatch(steps, options);
  return `return agentBatch(${encodeJson(steps)}, ${encodeJson(options)});`;
}

/**
 * The run timeout (seconds) a batch of `stepCount` steps gets when the caller
 * names none: the surface's own default, or enough for every step to spend
 * its default action budget, whichever is larger, capped at ten minutes.
 */
export function agentBatchTimeoutSeconds(stepCount: number, defaultSeconds: number) {
  const perStep = DEFAULT_STEP_TIMEOUT_MS / 1000;
  const steps = Math.max(1, Math.floor(stepCount) || 1);
  return Math.min(600, Math.max(defaultSeconds, 15 + perStep * steps));
}

// --- Execution ---------------------------------------------------------------

function describeError(error: UntrustedValue) {
  const message = String(untrustedField(error, "message") || error || "step failed");
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}…` : message;
}

/**
 * Tracks document/fetch/XHR requests on the current page so an observation
 * after a write waits for the work that write started, and no longer.
 */
class PageActivity {
  page = null;
  pending = new Set<UntrustedValue>();
  private readonly started = (request) => {
    if (["document", "fetch", "xhr"].includes(request.resourceType())) this.pending.add(request);
  };
  private readonly ended = (request) => {
    this.pending.delete(request);
  };

  attach(page) {
    if (this.page === page) return;
    this.detach();
    this.page = page;
    page.on("request", this.started);
    page.on("requestfinished", this.ended);
    page.on("requestfailed", this.ended);
  }

  detach() {
    if (!this.page) return;
    this.page.off("request", this.started);
    this.page.off("requestfinished", this.ended);
    this.page.off("requestfailed", this.ended);
    this.page = null;
    this.pending.clear();
  }

  /** Wait until nothing relevant is in flight, for at most `budgetMs`. */
  async settle(budgetMs: number) {
    if (!this.page || budgetMs <= 0) return;
    const deadline = Date.now() + budgetMs;
    await this.page
      .waitForLoadState("domcontentloaded", { timeout: budgetMs })
      .catch(() => {});
    while (this.pending.size && Date.now() < deadline) await hostDelay(POLL_MS);
  }
}

async function pageInfo(host: AgentBatchHost, page): Promise<AgentBatchPageInfo> {
  let title = "";
  try {
    title = String(await page.title()).replace(/\s+/g, " ").trim().slice(0, 120);
  } catch {
    // A page mid-navigation can refuse title(); the URL still identifies it.
  }
  return { id: host.pageId(page), url: page.url(), title };
}

async function pollUntil(condition: () => Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await condition()) return true;
    await hostDelay(POLL_MS);
  } while (Date.now() < deadline);
  return condition();
}

async function readElement(locator, step: AgentBatchStep, timeout: number): Promise<AgentBatchReading> {
  // `all` reads every match, hidden ones included; a single read waits for
  // the element to be visible, as a person reading the page would.
  const reading: AgentBatchReading = await readLocator(locator, {
    state: step.all ? "attached" : "visible",
    timeout,
  });
  if (step.attribute !== undefined) {
    // The `value` attribute of a password input is the secret's default; the
    // reading already redacts the live value, so redact the attribute too.
    const password = step.attribute.toLowerCase() === "value" && (await isPasswordField(locator));
    reading.attribute = password ? "[redacted]" : await locator.getAttribute(step.attribute);
  }
  return reading;
}

async function assertFillable(locator, step: AgentBatchStep, options: AgentBatchPlanOptions) {
  if ((await isPasswordField(locator)) && !options.allowPasswords) {
    throw new Error(
      `${stepLabel(step.id)} cannot ${step.action} a password field. Use the login tool or credentials.fill() for stored secrets; pass allowPasswords:true only for a password the task itself supplied.`,
    );
  }
}

interface NavigationOptions {
  waitUntil?: AgentBatchWaitUntil;
  timeout?: number;
}

function navigationOptions(step: AgentBatchStep) {
  const options: NavigationOptions = {};
  if (step.waitUntil !== undefined) options.waitUntil = step.waitUntil;
  if (step.timeoutMs !== undefined) options.timeout = step.timeoutMs;
  return options;
}

async function runStep(
  host: AgentBatchHost,
  page,
  step: AgentBatchStep,
  options: AgentBatchPlanOptions,
): Promise<Partial<AgentBatchStepResult>> {
  const labels = targetLabels(step.id);
  const timeout = step.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
  const locate = () => uniqueLocator(locatorFor(page, step.target, labels), labels, timeout);
  switch (step.action) {
    case "goto": {
      host.assertNavigationUrl(step.url);
      const response = await page.goto(step.url, navigationOptions(step));
      const outcome: Partial<AgentBatchStepResult> = { url: page.url() };
      if (response) outcome.status = response.status();
      return outcome;
    }
    case "back":
      await page.goBack(navigationOptions(step));
      return { url: page.url() };
    case "forward":
      await page.goForward(navigationOptions(step));
      return { url: page.url() };
    case "reload":
      await page.reload(navigationOptions(step));
      return { url: page.url() };
    case "click":
      await (await locate()).click({ timeout });
      return {};
    case "dblclick":
      await (await locate()).dblclick({ timeout });
      return {};
    case "hover":
      await (await locate()).hover({ timeout });
      return {};
    case "fill": {
      const locator = await locate();
      await assertFillable(locator, step, options);
      await locator.fill(step.value, { timeout });
      return { filled: step.value.length };
    }
    case "type": {
      const locator = await locate();
      await assertFillable(locator, step, options);
      if (!step.append) await locator.clear({ timeout });
      await locator.pressSequentially(step.value, { timeout });
      return { typed: step.value.length };
    }
    case "press":
      if (step.target === undefined) await page.keyboard.press(step.key);
      else await (await locate()).press(step.key, { timeout });
      return { pressed: step.key };
    case "select":
      return { selected: await (await locate()).selectOption(step.values, { timeout }) };
    case "check":
      await (await locate()).check({ timeout });
      return { checked: true };
    case "uncheck":
      await (await locate()).uncheck({ timeout });
      return { checked: false };
    case "scroll":
      if (step.target !== undefined) {
        await (await locate()).scrollIntoViewIfNeeded({ timeout });
        return { scrolled: "target" };
      }
      await page.mouse.wheel(step.dx, step.dy);
      return { scrolled: { dx: step.dx, dy: step.dy } };
    case "wait": {
      const startedAt = Date.now();
      if (step.target !== undefined) {
        await locatorFor(page, step.target, labels).first().waitFor({ state: step.state, timeout });
        return { waited: "target", ms: Date.now() - startedAt };
      }
      if (step.url !== undefined) {
        const url = step.url;
        if (!(await pollUntil(async () => page.url().includes(url), timeout))) {
          throw new Error(
            `${stepLabel(step.id)} URL did not include ${JSON.stringify(url)} within ${timeout}ms; current URL is ${page.url()}.`,
          );
        }
        return { waited: "url", ms: Date.now() - startedAt };
      }
      if (step.text !== undefined) {
        await page.getByText(step.text).first().waitFor({ state: "visible", timeout });
        return { waited: "text", ms: Date.now() - startedAt };
      }
      await hostDelay(step.ms);
      return { waited: "ms", ms: Date.now() - startedAt };
    }
    case "read": {
      if (step.all) {
        const locator = locatorFor(page, step.target, labels);
        await locator.first().waitFor({ state: "attached", timeout });
        const count = await locator.count();
        const items: AgentBatchReading[] = [];
        for (let index = 0; index < Math.min(count, MAX_READ_ALL); index += 1) {
          items.push(await readElement(locator.nth(index), step, timeout));
        }
        return { count, items };
      }
      const locator = await locate();
      let reading = await readElement(locator, step, timeout);
      if (step.expect !== undefined) {
        const expected = step.expect;
        const matches = (current: AgentBatchReading) =>
          [current.text, current.value].some((entry) => isString(entry) && entry.includes(expected));
        const satisfied = await pollUntil(async () => {
          if (matches(reading)) return true;
          reading = await readElement(locator, step, timeout);
          return matches(reading);
        }, timeout);
        if (!satisfied) {
          throw new Error(
            `${stepLabel(step.id)} did not show expected text/value ${JSON.stringify(expected)} within ${timeout}ms; last text was ${JSON.stringify(reading.text.slice(0, 200))}.`,
          );
        }
      }
      return reading;
    }
    case "url": {
      if (step.expect !== undefined) {
        const expected = step.expect;
        if (!(await pollUntil(async () => page.url().includes(expected), timeout))) {
          throw new Error(
            `${stepLabel(step.id)} URL did not include ${JSON.stringify(expected)} within ${timeout}ms; current URL is ${page.url()}.`,
          );
        }
      }
      const info = await pageInfo(host, page);
      return { url: info.url, title: info.title };
    }
    case "snapshot":
      return { snapshot: await host.snapshot(step.snapshot) };
    case "screenshot":
      return { screenshot: await host.screenshot(step.screenshot) };
    case "openPage": {
      const opened = await host.openPage(step.url);
      return { pageId: host.pageId(opened), url: opened.url() };
    }
    case "usePage": {
      const selected = await host.usePage(step.page);
      return { pageId: host.pageId(selected), url: selected.url() };
    }
    case "closePage":
      return host.closePage(step.page);
    case "dialog":
      host.armDialog(step.response, step.promptText);
      return { prepared: step.response };
    case "overlays":
      return host.dismissOverlays(page);
    default:
      throw new Error(`${stepLabel(step.id)} has unsupported action ${JSON.stringify(step.action)}.`);
  }
}

/**
 * Run a batch against the host's current page. Steps run in order with no
 * pacing unless `minIntervalMs` asks for some; a failed step stops the batch
 * (or is recorded and skipped when `optional`), and the result always carries
 * a final observation of the page so the caller can plan its next call.
 */
export async function executeAgentBatch(
  host: AgentBatchHost,
  stepsValue: UntrustedValue,
  optionsValue?: UntrustedValue,
): Promise<AgentBatchResult> {
  const { steps, options } = normalizeAgentBatch(stepsValue, optionsValue);
  const startedAt = Date.now();
  const results: AgentBatchStepResult[] = [];
  const activity = new PageActivity();
  let failed: AgentBatchFailure | undefined;
  let completed = 0;
  let unsettled = false;
  let page = await host.currentPage();
  try {
    for (const [index, step] of steps.entries()) {
      if (index && options.minIntervalMs) await hostDelay(options.minIntervalMs);
      page = await host.currentPage();
      activity.attach(page);
      try {
        if (unsettled && OBSERVING_ACTIONS.has(step.action)) {
          await activity.settle(options.settleMs);
          unsettled = false;
        }
        const data = await runStep(host, page, step, options);
        results.push({ id: step.id, action: step.action, ok: true, ...data });
        completed += 1;
        if (UNSETTLING_ACTIONS.has(step.action)) unsettled = true;
      } catch (error) {
        const message = describeError(error);
        results.push({ id: step.id, action: step.action, ok: false, error: message });
        if (UNSETTLING_ACTIONS.has(step.action)) unsettled = true;
        if (step.optional) continue;
        failed = { index, id: step.id, action: step.action, error: message };
        break;
      }
    }
    page = await host.currentPage();
    activity.attach(page);
    if (unsettled && options.observe !== "none") await activity.settle(options.settleMs);
  } finally {
    activity.detach();
  }
  const result: AgentBatchResult = {
    protocol: AGENT_BATCH_PROTOCOL,
    ok: failed === undefined,
    completed,
    total: steps.length,
    steps: results,
    page: await pageInfo(host, page),
    durationMs: 0,
  };
  if (failed) result.failed = failed;
  if (options.observe !== "none") {
    try {
      result.snapshot = await host.snapshot({ interactive: true, diff: options.observe === "diff" });
      host.observed?.(page);
    } catch (error) {
      result.observeError = describeError(error);
    }
  }
  // Proof means "the task's visible end state"; a batch that stopped short
  // has none, and the snapshot already shows where it stopped.
  if (options.proof && result.ok) result.proof = await host.screenshot({ kind: "proof" });
  result.durationMs = Date.now() - startedAt;
  return result;
}
