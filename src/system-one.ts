// Host-side System One (Jev) loop: typed decisions over a discovered directory.
// The API key and page payload never enter the model sandbox. Stop rules,
// locator fallback, and dialog/login detection live here so a cheap choice
// model cannot loop, fill passwords, or invent targets.

import {
  isNumber,
  isRecord,
  isString,
  type UntrustedValue,
  untrustedField,
} from "./untrusted-value.js";

export const SYSTEM_ONE_API_URL = "https://api.typesafe.ai/v1/systemone";
export const SYSTEM_ONE_DEFAULT_MODEL = "jev-latest";
export const SYSTEM_ONE_NONE = "none";
const MAX_CANDIDATES = 40;
const DEFAULT_MAX_STEPS = 8;
const DEFAULT_CONFIDENCE_FLOOR = 0.45;
const DEFAULT_SETTLE_MS = 300;
const AUTH_NAME = /\b(sign[\s-]?in|log[\s-]?in|authenticate)\b/i;
const DESTRUCTIVE_NAME = /\b(delete account|remove account|destroy workspace|wipe (?:all )?data)\b/i;
const PAGINATION_NAME = /^(next|previous|prev|older|newer)(?:\s|$|[\u2192\u00bb\u203a\u25b8\u25ba])/i;
const TRAILING_ARROW = /\s*[\u2192\u00bb\u203a\u25b8\u25ba\u2190]+$/u;
const PARENTHETICAL = /^(.*) \([^)]+\)$/;
const SNAPSHOT_CONTROL = /^\s*- (link|button) "([^"]*)" \[ref=([A-Za-z0-9_-]+)\]/;
const TARGET_KEYS = [
  "ref",
  "role",
  "name",
  "label",
  "text",
  "placeholder",
  "css",
  "exact",
  "nth",
  "frameName",
  "frameUrlIncludes",
  "testId",
] as const;

export type FollowIntentReason =
  | "completed"
  | "unresolved"
  | "blocked"
  | "loop"
  | "login"
  | "error";

export interface DirectoryTarget {
  ref?: UntrustedValue;
  role?: UntrustedValue;
  name?: UntrustedValue;
  label?: UntrustedValue;
  text?: UntrustedValue;
  placeholder?: UntrustedValue;
  css?: UntrustedValue;
  exact?: UntrustedValue;
  nth?: UntrustedValue;
  frameName?: UntrustedValue;
  frameUrlIncludes?: UntrustedValue;
  testId?: UntrustedValue;
}

export interface SystemOneCandidate {
  id: string;
  target: DirectoryTarget;
  actions: string[];
  role: string;
  name: string;
  context: string;
  frame: string;
  disabled: boolean;
  value: string;
  options: UntrustedValue[];
  dialog: boolean;
}

export interface ObservedPage {
  url: string;
  title: string;
  oracle: string;
  evidence: UntrustedValue[];
  snapshotText: string;
  dialogs: Array<{ role: string; text: string }>;
  candidates: SystemOneCandidate[];
  truncated: boolean;
}

export interface FollowIntentOptions {
  intent: string;
  url?: string;
  query?: string | string[];
  expect?: string;
  maxSteps?: number;
  act?: boolean;
  allowAuthentication?: boolean;
  allowDestructive?: boolean;
  confidenceFloor?: number;
  settleMs?: number;
  session?: string;
  timeout?: number;
  model?: string;
}

export interface FollowIntentStep {
  step: number;
  url: string;
  oracle: string;
  pageState?: string;
  targetId?: string;
  confidence?: number;
  itemPresent?: number;
  action: string;
  reason?: FollowIntentReason;
  candidate?: { name: string; role: string; context: string; dialog?: boolean };
}

export interface FollowIntentResult {
  ok: boolean;
  reason: FollowIntentReason;
  intent: string;
  url?: string;
  title?: string;
  oracle?: string;
  target?: { id: string; name: string; role: string; target: DirectoryTarget };
  steps: FollowIntentStep[];
  error?: string;
}

export interface SystemOneAskRequest {
  state: UntrustedValue;
  model: string;
  questions: UntrustedValue;
}

export interface FollowIntentDeps {
  observe: (query: string | string[] | undefined) => Promise<UntrustedValue>;
  act: (candidate: SystemOneCandidate, option: string | undefined) => Promise<{ ok: boolean; error?: string }>;
  ask: (request: SystemOneAskRequest) => Promise<UntrustedValue>;
  wait: (ms: number) => Promise<void>;
}

export function systemOneApiKey(env: NodeJS.Dict<string> = process.env): string {
  return String(env.BETTERWRIGHT_TYPESAFE_API_KEY || env.TYPESAFE_API_KEY || "").trim();
}

export function systemOneMissingKeyError() {
  return "followIntent requires BETTERWRIGHT_TYPESAFE_API_KEY or TYPESAFE_API_KEY.";
}

function clip(value: UntrustedValue, max = 240) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function encode(value: UntrustedValue) {
  if (value === undefined) return "undefined";
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

export function fingerprintCandidate(candidate: SystemOneCandidate) {
  return JSON.stringify({
    name: candidate.name,
    role: candidate.role,
    nth: candidate.target.nth ?? null,
    frame: candidate.frame,
    context: candidate.context,
  });
}

export function isPaginationControl(candidate: SystemOneCandidate) {
  return PAGINATION_NAME.test(candidate.name);
}

export function isAuthControl(candidate: SystemOneCandidate) {
  if (candidate.role === "textbox" && /password/i.test(candidate.name)) return true;
  return AUTH_NAME.test(candidate.name);
}

export function isDestructiveControl(candidate: SystemOneCandidate) {
  return DESTRUCTIVE_NAME.test(candidate.name);
}

function copyDirectoryTarget(value: UntrustedValue): DirectoryTarget {
  const target: DirectoryTarget = {};
  if (!isRecord(value)) return target;
  for (const key of TARGET_KEYS) {
    const field = untrustedField(value, key);
    if (field !== undefined) target[key] = field;
  }
  return target;
}

export function fallbackTargets(target: DirectoryTarget) {
  const out = [target];
  const push = (next: DirectoryTarget) => {
    const key = JSON.stringify(next);
    if (!out.some((entry) => JSON.stringify(entry) === key)) out.push(next);
  };
  if (target.exact === true) push({ ...target, exact: false });
  for (const key of ["name", "label", "text"] as const) {
    if (!isString(target[key])) continue;
    const stripped = target[key].replace(TRAILING_ARROW, "").trim();
    if (stripped && stripped !== target[key]) {
      push({ ...target, [key]: stripped, exact: true });
      push({ ...target, [key]: stripped, exact: false });
    }
    const parenthetical = PARENTHETICAL.exec(target[key]);
    if (parenthetical?.[1]) {
      push({ ...target, [key]: parenthetical[1], exact: true });
      push({ ...target, [key]: parenthetical[1], exact: false });
    }
  }
  return out;
}

export function actionFor(candidate: SystemOneCandidate) {
  if (candidate.actions.includes("select")) return "select";
  if (candidate.actions.includes("check")) return "check";
  if (candidate.actions.includes("fill")) return "fill";
  return "click";
}

export function candidatesFromDirectory(directory: UntrustedValue): SystemOneCandidate[] {
  const controls = untrustedField(directory, "controls");
  if (!Array.isArray(controls)) return [];
  return controls.slice(0, MAX_CANDIDATES).map((control, index) => {
    const target = copyDirectoryTarget(untrustedField(control, "target"));
    const actionsValue = untrustedField(control, "actions");
    const optionsValue = untrustedField(control, "options");
    const name = clip(
      target.name || target.label || target.text || target.placeholder || target.role || "unnamed",
      80,
    );
    return {
      id: `opt_${String(index).padStart(2, "0")}`,
      target,
      actions: Array.isArray(actionsValue) ? actionsValue.filter(isString) : [],
      role: clip(target.role || untrustedField(control, "role") || "unknown", 40),
      name,
      context: clip(untrustedField(control, "context"), 160),
      frame: clip(target.frameName || target.frameUrlIncludes, 80),
      disabled: untrustedField(control, "disabled") === true,
      value: clip(untrustedField(control, "value"), 80),
      options: Array.isArray(optionsValue) ? optionsValue : [],
      dialog: untrustedField(control, "dialog") === true,
    };
  });
}

export function extraCandidatesFromSnapshot(snapshotText: string, startIndex: number) {
  const extras: SystemOneCandidate[] = [];
  const seen = new Set<string>();
  const text = String(snapshotText || "");
  const pattern = new RegExp(SNAPSHOT_CONTROL, "gm");
  let match = pattern.exec(text);
  while (match) {
    const name = clip(match[2], 80);
    const key = `${match[1]}:${name.toLowerCase()}`;
    if (name && !seen.has(key) && extras.length < 24) {
      seen.add(key);
      extras.push({
        id: `opt_${String(startIndex + extras.length).padStart(2, "0")}`,
        target: { ref: match[3] },
        actions: ["click"],
        role: match[1],
        name,
        context: "from snapshot",
        frame: "",
        disabled: false,
        value: "",
        options: [],
        dialog: false,
      });
    }
    match = pattern.exec(text);
  }
  return extras;
}

export function parseObserved(value: UntrustedValue): ObservedPage {
  const directory = untrustedField(value, "directory");
  const candidates = candidatesFromDirectory(directory);
  const names = new Set(candidates.map((candidate) => `${candidate.role}:${candidate.name.toLowerCase()}`));
  const snapshotLines = String(untrustedField(value, "snapshotText") ?? "").slice(0, 8_000);
  for (const extra of extraCandidatesFromSnapshot(snapshotLines, candidates.length)) {
    const key = `${extra.role}:${extra.name.toLowerCase()}`;
    if (names.has(key)) continue;
    candidates.push(extra);
    names.add(key);
  }
  const dialogsValue = untrustedField(value, "dialogs");
  const evidenceValue = untrustedField(directory, "evidence") ?? untrustedField(value, "evidence");
  return {
    url: clip(untrustedField(value, "url"), 500),
    title: clip(untrustedField(value, "title"), 200),
    oracle: clip(untrustedField(value, "oracle"), 240),
    evidence: Array.isArray(evidenceValue) ? evidenceValue : [],
    snapshotText: clip(untrustedField(value, "snapshotText"), 3_500),
    dialogs: Array.isArray(dialogsValue)
      ? dialogsValue.slice(0, 8).map((entry) => ({
        role: clip(untrustedField(entry, "role"), 40),
        text: clip(untrustedField(entry, "text"), 240),
      }))
      : [],
    candidates,
    truncated: untrustedField(directory, "truncated") === true,
  };
}

function describeCandidate(candidate: SystemOneCandidate) {
  const parts = [`${candidate.role} "${candidate.name}"`];
  if (candidate.context) parts.push(`context: ${candidate.context}`);
  if (candidate.frame) parts.push(`frame: ${candidate.frame}`);
  if (candidate.dialog) parts.push("in open dialog");
  if (candidate.disabled) parts.push("disabled");
  if (candidate.options.length) {
    parts.push(`options: ${candidate.options.map((option) => clip(Array.isArray(option) ? option[0] : option, 40)).filter(Boolean).join(" | ")}`);
  }
  parts.push(`actions: ${candidate.actions.join("/") || "none"}`);
  return parts.join("; ");
}

export function observedLooksLikeLogin(observed: ObservedPage) {
  if (observed.candidates.some((candidate) => candidate.role === "textbox" && /password/i.test(candidate.name))) {
    return true;
  }
  if (observed.candidates.some((candidate) => candidate.dialog && AUTH_NAME.test(candidate.name))) {
    return true;
  }
  return observed.dialogs.some((dialog) => AUTH_NAME.test(dialog.text) || /password/i.test(dialog.text));
}

export function observedMatchesExpect(observed: ObservedPage, expected: string | undefined) {
  if (!expected) return false;
  const haystack = [observed.oracle, observed.title, observed.url, observed.snapshotText, JSON.stringify(observed.evidence)].join("\n");
  return haystack.includes(expected);
}

function optionCriteria(candidates: SystemOneCandidate[]) {
  const criteria = new Map([["not_applicable", "The next action is not choosing a dropdown option."]]);
  for (const candidate of candidates) {
    for (const option of candidate.options) {
      const label = clip(Array.isArray(option) ? option[0] : option, 60);
      const value = clip(Array.isArray(option) ? option[1] || option[0] : option, 60);
      if (!label) continue;
      criteria.set(`${candidate.id}__${value || label}`, `${candidate.name}: ${label}`);
    }
  }
  return Object.fromEntries(criteria);
}

export function buildSystemOneRequest(intent: string, observed: ObservedPage, model: string): SystemOneAskRequest {
  const criteria = new Map([
    [SYSTEM_ONE_NONE, "No safe or matching control. Use this for login walls, missing items, or destructive actions that were not requested."],
  ]);
  for (const candidate of observed.candidates) {
    criteria.set(candidate.id, describeCandidate(candidate));
  }
  return {
    model,
    state: {
      intent,
      url: observed.url,
      title: observed.title,
      evidence: observed.evidence,
      oracle: observed.oracle,
      dialogs: observed.dialogs,
      snapshot: observed.snapshotText,
    },
    questions: {
      page_state: {
        type: "choice",
        instructions: "What kind of page is this relative to the intent?",
        criteria: {
          listing: "A list, table, search results, or directory that may need filtering or pagination",
          detail: "The requested item or destination is present",
          overlay: "Cookie, promo, or other overlay is blocking the page",
          login: "Authentication is required before the requested action",
          other: "Something else",
        },
      },
      target: {
        type: "choice",
        instructions: "Which control should be used next to accomplish the intent? Choose none if the next action is unsafe, blocked by login, or not present.",
        criteria: Object.fromEntries(criteria),
      },
      dropdown_option: {
        type: "choice",
        instructions: "If the next control is a dropdown or select, which option should be chosen? Otherwise not_applicable.",
        criteria: optionCriteria(observed.candidates),
      },
      item_present: {
        type: "noul",
        instructions: "The specific item or outcome described in the intent is already visible on this page.",
      },
    },
  };
}

export interface InterpretedDecision {
  pageState: string;
  targetId: string;
  confidence: number;
  targetProbability: number;
  itemPresent: number;
  dropdown?: string;
  candidate?: SystemOneCandidate;
}

export function interpretDecision(answers: UntrustedValue, candidates: SystemOneCandidate[]): InterpretedDecision {
  const target = untrustedField(answers, "target");
  const pageState = untrustedField(answers, "page_state");
  const itemPresent = untrustedField(answers, "item_present");
  const dropdown = untrustedField(answers, "dropdown_option");
  const targetId = isString(untrustedField(target, "choice")) ? String(untrustedField(target, "choice")) : SYSTEM_ONE_NONE;
  const probabilities = untrustedField(target, "probabilities");
  const targetProbability = isNumber(untrustedField(probabilities, targetId))
    ? Number(untrustedField(probabilities, targetId))
    : 0;
  return {
    pageState: isString(untrustedField(pageState, "choice")) ? String(untrustedField(pageState, "choice")) : "other",
    targetId,
    confidence: isNumber(untrustedField(target, "confidence")) ? Number(untrustedField(target, "confidence")) : 0,
    targetProbability,
    itemPresent: isNumber(untrustedField(itemPresent, "noul")) ? Number(untrustedField(itemPresent, "noul")) : 0,
    dropdown: isString(untrustedField(dropdown, "choice")) ? String(untrustedField(dropdown, "choice")) : undefined,
    candidate: candidates.find((candidate) => candidate.id === targetId),
  };
}

interface ActionChoice {
  action: string;
  reason?: FollowIntentReason;
}

export function decideAction(
  decision: InterpretedDecision,
  observed: ObservedPage,
  options: FollowIntentOptions,
  history: Array<{ fingerprint: string; url: string }>,
): ActionChoice {
  const floor = isNumber(options.confidenceFloor) ? options.confidenceFloor : DEFAULT_CONFIDENCE_FLOOR;
  const candidate = decision.candidate;
  if (observedLooksLikeLogin(observed) && !options.allowAuthentication) {
    return { action: "abstain", reason: "login" };
  }
  if (decision.pageState === "login" && !options.allowAuthentication) {
    return { action: "abstain", reason: "login" };
  }
  if (!candidate || decision.targetId === SYSTEM_ONE_NONE) {
    return { action: "abstain", reason: "unresolved" };
  }
  if (candidate.disabled) return { action: "abstain", reason: "unresolved" };
  if (isAuthControl(candidate) && !options.allowAuthentication) {
    return { action: "abstain", reason: "login" };
  }
  if (actionFor(candidate) === "fill" && /password/i.test(candidate.name)) {
    return { action: "abstain", reason: "blocked" };
  }
  if (isDestructiveControl(candidate) && !options.allowDestructive && !DESTRUCTIVE_NAME.test(options.intent)) {
    return { action: "abstain", reason: "blocked" };
  }
  const fingerprint = fingerprintCandidate(candidate);
  const same = history.some((entry) => entry.fingerprint === fingerprint && entry.url === observed.url);
  if (same) {
    if (observedMatchesExpect(observed, options.expect)) return { action: "abstain", reason: "completed" };
    return { action: "abstain", reason: "loop" };
  }
  const paginating = isPaginationControl(candidate) && decision.itemPresent < 0.35;
  const confident = decision.confidence >= floor || (paginating && (decision.confidence >= 0.3 || decision.targetProbability >= 0.5));
  if (!confident) return { action: "abstain", reason: "unresolved" };
  return { action: actionFor(candidate) };
}

export function dropdownValue(dropdown: string | undefined) {
  if (!dropdown || dropdown === "not_applicable") return undefined;
  return dropdown.includes("__") ? dropdown.split("__").slice(1).join("__") : dropdown;
}

export function observeSnippet(query: string | string[] | undefined) {
  const directoryArg = query === undefined ? "" : encode({ query });
  return `const directory = await controls.directory(${directoryArg});
    let snapshotText = "";
    try { snapshotText = await snapshot({ interactive: true, maxChars: 3500, timeout: 2500 }); }
    catch { snapshotText = ""; }
    let oracle = "";
    try { oracle = await page.locator("#oracle, [role='status'], [role='alert']").first().innerText({ timeout: 400 }); }
    catch {}
    const dialogs = await page.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        return Boolean(element.getClientRects().length) && style.visibility !== "hidden" && style.display !== "none";
      };
      return [...document.querySelectorAll("dialog[open], [role='dialog'], [aria-modal='true']")]
        .filter((element) => visible(element))
        .slice(0, 8)
        .map((element) => ({
          role: element.getAttribute("role") || (element.tagName === "DIALOG" ? "dialog" : ""),
          text: String(element.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 240),
        }));
    });
    return { url: page.url(), title: await page.title(), directory, snapshotText, oracle, dialogs };`;
}

export function actSnippet(candidate: SystemOneCandidate, option: string | undefined) {
  const action = actionFor(candidate);
  const targets = fallbackTargets(candidate.target);
  return `const targets = ${encode(targets)};
    const action = ${encode(action)};
    const value = ${encode(option)};
    let lastError = "No locator fallback matched.";
    for (const target of targets) {
      const operation = { id: "act", action, target };
      if (action === "select") {
        if (!value) throw new Error("select requires a dropdown option");
        operation.value = value;
      }
      try {
        return await controls.batch({ operations: [operation], allowWrites: true, observe: true });
      } catch (error) {
        lastError = String(error && error.message || error);
        if (!/Timeout|waitFor|strict mode violation|matched 0 elements/i.test(lastError)) throw error;
      }
    }
    throw new Error(lastError);`;
}

export function followIntentDeps(
  run: (code: string, options?: { note?: string; timeout?: number; session?: string }) => Promise<{ ok: boolean; result?: UntrustedValue; error?: string }>,
  ask: FollowIntentDeps["ask"],
  options: FollowIntentOptions,
): FollowIntentDeps {
  const runOptions = { session: options.session, timeout: options.timeout };
  return {
    observe: async (query) => {
      const result = await run(observeSnippet(query), { ...runOptions, note: "followIntent observe" });
      if (!result.ok) throw new Error(result.error || "observe failed");
      return result.result;
    },
    act: async (candidate, option) => {
      const result = await run(actSnippet(candidate, option), { ...runOptions, note: "followIntent act" });
      return { ok: result.ok === true, error: result.error };
    },
    ask,
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

export async function postSystemOne(
  request: SystemOneAskRequest,
  options: { apiKey: string; url?: string; fetch?: typeof fetch },
) {
  const fetchImpl = options.fetch || fetch;
  const response = await fetchImpl(options.url || SYSTEM_ONE_API_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(request),
  });
  const text = await response.text();
  let body: UntrustedValue;
  try { body = JSON.parse(text); } catch { body = { raw: clip(text, 400) }; }
  if (!response.ok) {
    throw new Error(`System One HTTP ${response.status}: ${clip(text, 300)}`);
  }
  return body;
}

export async function runFollowIntent(
  deps: FollowIntentDeps,
  options: FollowIntentOptions,
): Promise<FollowIntentResult> {
  const intent = clip(options.intent, 2_000);
  const steps: FollowIntentStep[] = [];
  const history: Array<{ fingerprint: string; url: string }> = [];
  const maxSteps = Math.max(1, Math.min(options.maxSteps ?? DEFAULT_MAX_STEPS, 16));
  const settleMs = Math.max(0, Math.min(options.settleMs ?? DEFAULT_SETTLE_MS, 2_000));
  const act = options.act !== false;
  const model = isString(options.model) && options.model.trim() ? options.model.trim() : SYSTEM_ONE_DEFAULT_MODEL;
  let observed: ObservedPage | undefined;
  try {
    for (let step = 1; step <= maxSteps; step += 1) {
      observed = parseObserved(await deps.observe(options.query));
      if (observedMatchesExpect(observed, options.expect)) {
        return {
          ok: true,
          reason: "completed",
          intent,
          url: observed.url,
          title: observed.title,
          oracle: observed.oracle,
          steps,
        };
      }
      if (observedLooksLikeLogin(observed) && !options.allowAuthentication && history.length) {
        return {
          ok: false,
          reason: "login",
          intent,
          url: observed.url,
          title: observed.title,
          oracle: observed.oracle,
          steps: [...steps, {
            step, url: observed.url, oracle: observed.oracle, action: "abstain", reason: "login",
          }],
        };
      }
      const request = buildSystemOneRequest(intent, observed, model);
      const response = await deps.ask(request);
      const decision = interpretDecision(untrustedField(response, "answers"), observed.candidates);
      const choice = decideAction(decision, observed, options, history);
      const stepRecord: FollowIntentStep = {
        step,
        url: observed.url,
        oracle: observed.oracle,
        pageState: decision.pageState,
        targetId: decision.targetId,
        confidence: decision.confidence,
        itemPresent: decision.itemPresent,
        action: choice.action,
        reason: choice.reason,
        candidate: decision.candidate
          ? {
            name: decision.candidate.name,
            role: decision.candidate.role,
            context: decision.candidate.context,
            dialog: decision.candidate.dialog,
          }
          : undefined,
      };
      steps.push(stepRecord);
      const chosen = decision.candidate;
      if (choice.action === "abstain" || !act || !chosen) {
        const unresolvedOk = choice.reason === "completed";
        const reason: FollowIntentReason = choice.reason ?? "unresolved";
        return {
          ok: unresolvedOk,
          reason,
          intent,
          url: observed.url,
          title: observed.title,
          oracle: observed.oracle,
          target: chosen
            ? {
              id: chosen.id,
              name: chosen.name,
              role: chosen.role,
              target: chosen.target,
            }
            : undefined,
          steps,
        };
      }
      const acted = await deps.act(chosen, dropdownValue(decision.dropdown));
      if (!acted.ok) {
        return {
          ok: false,
          reason: "error",
          intent,
          url: observed.url,
          title: observed.title,
          oracle: observed.oracle,
          steps,
          error: acted.error || "act failed",
        };
      }
      history.push({ fingerprint: fingerprintCandidate(chosen), url: observed.url });
      if (settleMs) await deps.wait(settleMs);
    }
    observed = parseObserved(await deps.observe(options.query));
    const completed = observedMatchesExpect(observed, options.expect);
    return {
      ok: completed,
      reason: completed ? "completed" : "unresolved",
      intent,
      url: observed.url,
      title: observed.title,
      oracle: observed.oracle,
      steps,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "error",
      intent,
      url: observed?.url,
      title: observed?.title,
      oracle: observed?.oracle,
      steps,
      error: clip(error instanceof Error ? error.message : error, 400),
    };
  }
}
