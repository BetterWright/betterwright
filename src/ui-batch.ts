import { setTimeout as hostDelay } from "node:timers/promises";

import {
  boundedString,
  isPasswordField,
  readLocator,
  type TargetLabels,
  targetLocator,
  uniqueLocator,
} from "./batch-targets.js";
import { inspectActionDirectory } from "./page-inspect.js";
import { isNumber, isRecord, isString, type UntrustedValue, untrustedField } from "./untrusted-value.js";

const MAX_OPERATIONS = 32;
const MAX_JSON_CHARS = 128_000;
const MAX_TEXT_CHARS = 10_000;
const MAX_PACING_MS = 1_000;
const MAX_DIRECTORY_WAIT_MS = 5_000;
const EXPECTATION_TIMEOUT_MS = 10_000;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const READ_ACTIONS = new Set(["read", "readUrl"]);
const ACTIONS = new Set([
  "click",
  "fill",
  "select",
  "check",
  "uncheck",
  "press",
  "read",
  "readUrl",
]);

interface UIBatchOperationResult {
  ariaLabel?: string;
  checked?: boolean;
  clicked?: boolean;
  disabled?: boolean;
  durationMs?: number;
  filled?: number;
  pressed?: string;
  selected?: string[];
  tag?: string;
  text?: string;
  title?: string;
  url?: string;
  value?: string;
}

interface BatchActivity {
  lastAt: number;
  pending: Set<unknown>;
}

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

function operationLabels(operationId): TargetLabels {
  return { subject: `UI batch operation ${JSON.stringify(operationId)}`, fields: "UI batch" };
}

async function exactLocator(page, target, operationId) {
  const labels = operationLabels(operationId);
  return uniqueLocator(targetLocator(page, target, labels), labels);
}

async function readLocatorWhen(locator, expected, operationId) {
  if (expected === undefined) return readLocator(locator);
  if (!isString(expected) || !expected.trim() || expected.length > MAX_TEXT_CHARS) {
    throw new TypeError(
      `UI batch operation ${JSON.stringify(operationId)} read value must be a non-empty expected substring of at most ${MAX_TEXT_CHARS} characters.`,
    );
  }
  const deadline = Date.now() + EXPECTATION_TIMEOUT_MS;
  let result;
  do {
    result = await readLocator(locator);
    if ([result.text, result.value].some((value) => isString(value) && value.includes(expected))) {
      return result;
    }
    await hostDelay(25);
  } while (Date.now() < deadline);
  throw new Error(
    `UI batch operation ${JSON.stringify(operationId)} did not reach expected text/value ${JSON.stringify(expected)} within ${EXPECTATION_TIMEOUT_MS}ms.`,
  );
}

async function readUrlWhen(page, expected, operationId) {
  if (expected === undefined) return { url: page.url(), title: await page.title() };
  if (!isString(expected) || !expected.trim() || expected.length > 2_000) {
    throw new TypeError(
      `UI batch operation ${JSON.stringify(operationId)} readUrl value must be a non-empty expected URL substring of at most 2000 characters.`,
    );
  }
  const deadline = Date.now() + EXPECTATION_TIMEOUT_MS;
  while (!page.url().includes(expected) && Date.now() < deadline) await hostDelay(25);
  if (!page.url().includes(expected)) {
    throw new Error(
      `UI batch operation ${JSON.stringify(operationId)} URL did not include ${JSON.stringify(expected)} within ${EXPECTATION_TIMEOUT_MS}ms.`,
    );
  }
  return { url: page.url(), title: await page.title() };
}

async function assertNotPassword(locator, operationId, allowPasswordFill) {
  if ((await isPasswordField(locator)) && !allowPasswordFill) {
    throw new Error(
      `UI batch operation ${JSON.stringify(operationId)} cannot fill a password. Use credentials.fill(), credentials.generateAndFill(), or an explicitly task-supplied credential in ordinary browser code.`,
    );
  }
}

function normalizeOptions(value: UntrustedValue) {
  if (value === undefined) {
    return {
      allowWrites: false,
      allowIrreversible: false,
      minIntervalMs: 40,
      returnDirectory: false,
      directoryWaitMs: 0,
      allowPasswordFill: false,
    };
  }
  if (!isRecord(value)) throw new TypeError("controls.batch options must be an object.");
  const pacing = untrustedField(value, "minIntervalMs");
  if (pacing !== undefined && (!isNumber(pacing) || !Number.isInteger(pacing) || pacing < 0 || pacing > MAX_PACING_MS)) {
    throw new RangeError(`controls.batch minIntervalMs must be an integer from 0 to ${MAX_PACING_MS}.`);
  }
  const returnDirectory = untrustedField(value, "returnDirectory") === true;
  const directoryWait = untrustedField(value, "directoryWaitMs");
  if (
    directoryWait !== undefined &&
    (!isNumber(directoryWait) || !Number.isInteger(directoryWait) || directoryWait < 0 || directoryWait > MAX_DIRECTORY_WAIT_MS)
  ) {
    throw new RangeError(
      `controls.batch directoryWaitMs must be an integer from 0 to ${MAX_DIRECTORY_WAIT_MS}.`,
    );
  }
  return {
    allowWrites: untrustedField(value, "allowWrites") === true,
    allowIrreversible: untrustedField(value, "allowIrreversible") === true,
    minIntervalMs: pacing === undefined ? 40 : Number(pacing),
    returnDirectory,
    directoryWaitMs: directoryWait === undefined ? 2_500 : Number(directoryWait),
    allowPasswordFill: untrustedField(value, "allowPasswordFill") === true,
  };
}

async function refreshedActionDirectory(page, waitMs: number, activity: BatchActivity) {
  const deadline = Date.now() + waitMs;
  const minimumUntil = Date.now() + Math.min(125, waitMs);
  let directory = await inspectActionDirectory(page);
  let signature = JSON.stringify(directory);
  let stableSince = Date.now();
  do {
    await hostDelay(25);
    const next = await inspectActionDirectory(page);
    const nextSignature = JSON.stringify(next);
    if (nextSignature !== signature) {
      directory = next;
      signature = nextSignature;
      stableSince = Date.now();
    }
    const now = Date.now();
    if (
      now >= minimumUntil &&
      now - stableSince >= 100 &&
      now - activity.lastAt >= 100 &&
      activity.pending.size === 0
    ) {
      break;
    }
  } while (Date.now() < deadline);
  return directory;
}

async function settleAfterWrites(activity: BatchActivity, waitMs = 2_500) {
  const deadline = Date.now() + waitMs;
  const minimumUntil = Date.now() + Math.min(125, waitMs);
  do {
    const now = Date.now();
    if (
      now >= minimumUntil &&
      now - activity.lastAt >= 100 &&
      activity.pending.size === 0
    ) {
      return;
    }
    await hostDelay(25);
  } while (Date.now() < deadline);
}

/** A guarded one-call UI transaction for sites without a first-party protocol. */
export async function executeUIBatch(page, operationsValue: UntrustedValue, optionsValue?: UntrustedValue) {
  if (!Array.isArray(operationsValue) || !operationsValue.length) {
    throw new TypeError("controls.batch operations must be a non-empty array.");
  }
  if (operationsValue.length > MAX_OPERATIONS) {
    throw new RangeError(`controls.batch accepts at most ${MAX_OPERATIONS} operations.`);
  }
  cloneJson(operationsValue, "controls.batch operations");
  const options = normalizeOptions(optionsValue);
  const ids = new Set<string>();
  const operations = operationsValue.map((value, index) => {
    if (!isRecord(value)) throw new TypeError(`UI batch operation ${index + 1} must be an object.`);
    const id = boundedString(untrustedField(value, "id"), `UI batch operation ${index + 1} id`, 64);
    if (!ID_PATTERN.test(id)) throw new Error(`UI batch operation ${index + 1} has an invalid id.`);
    if (ids.has(id)) throw new Error(`UI batch operation id ${JSON.stringify(id)} is duplicated.`);
    ids.add(id);
    const action = boundedString(untrustedField(value, "action"), `UI batch operation ${JSON.stringify(id)} action`, 32);
    if (!ACTIONS.has(action)) throw new Error(`UI batch operation ${JSON.stringify(id)} has unsupported action ${JSON.stringify(action)}.`);
    const irreversible = untrustedField(value, "irreversible") === true;
    if (!READ_ACTIONS.has(action) && !options.allowWrites) {
      throw new Error(`UI batch action ${JSON.stringify(action)} changes page state; pass {allowWrites:true} only when authorized.`);
    }
    if (irreversible && !options.allowIrreversible) {
      throw new Error(`UI batch operation ${JSON.stringify(id)} is marked irreversible; pass {allowIrreversible:true} only after required confirmation.`);
    }
    const target = untrustedField(value, "target");
    if (action !== "readUrl" && !isRecord(target)) {
      throw new TypeError(`UI batch operation ${JSON.stringify(id)} requires a target.`);
    }
    return { id, action, target, value: untrustedField(value, "value"), irreversible };
  });
  const hasWrites = operations.some((operation) => !READ_ACTIONS.has(operation.action));
  const finalOperation = operations.at(-1);
  if (hasWrites && !READ_ACTIONS.has(finalOperation?.action || "")) {
    throw new Error("A mutating controls.batch transaction must end with read or readUrl verification.");
  }
  if (
    hasWrites &&
    (!isString(finalOperation?.value) || !finalOperation.value.trim())
  ) {
    throw new Error(
      "A mutating controls.batch transaction's final read/readUrl must include a non-empty expected value.",
    );
  }

  const results = new Map<string, UIBatchOperationResult>();
  const startedAt = Date.now();
  const activity: BatchActivity = { lastAt: startedAt, pending: new Set() };
  const relevantRequest = (request) => ["document", "fetch", "xhr"].includes(request.resourceType());
  const requestStarted = (request) => {
    if (!relevantRequest(request)) return;
    activity.pending.add(request);
    activity.lastAt = Date.now();
  };
  const requestEnded = (request) => {
    if (!activity.pending.delete(request)) return;
    activity.lastAt = Date.now();
  };
  if (hasWrites) {
    page.on("request", requestStarted);
    page.on("requestfinished", requestEnded);
    page.on("requestfailed", requestEnded);
  }
  try {
    let needsSettle = false;
    for (const [index, operation] of operations.entries()) {
      if (index && options.minIntervalMs) await hostDelay(options.minIntervalMs);
      const operationStartedAt = Date.now();
      try {
        if (READ_ACTIONS.has(operation.action) && needsSettle) {
          await settleAfterWrites(activity);
          needsSettle = false;
        }
        if (operation.action === "readUrl") {
          results.set(operation.id, await readUrlWhen(page, operation.value, operation.id));
          continue;
        }
        const locator = await exactLocator(page, operation.target, operation.id);
        if (operation.action === "click") {
          await locator.click();
          results.set(operation.id, { clicked: true });
        } else if (operation.action === "fill") {
          await assertNotPassword(locator, operation.id, options.allowPasswordFill);
          if (!isString(operation.value) || operation.value.length > MAX_TEXT_CHARS) {
            throw new TypeError(`UI batch operation ${JSON.stringify(operation.id)} fill value must be a string of at most ${MAX_TEXT_CHARS} characters.`);
          }
          await locator.fill(operation.value);
          results.set(operation.id, { filled: operation.value.length });
        } else if (operation.action === "select") {
          const values = Array.isArray(operation.value) ? operation.value : [operation.value];
          if (!values.length || values.length > 50 || values.some((entry) => !isString(entry) || !entry.length || entry.length > 500)) {
            throw new TypeError(`UI batch operation ${JSON.stringify(operation.id)} select value must be a string or a bounded string array.`);
          }
          results.set(operation.id, { selected: await locator.selectOption(values) });
        } else if (operation.action === "check") {
          await locator.check();
          results.set(operation.id, { checked: true });
        } else if (operation.action === "uncheck") {
          await locator.uncheck();
          results.set(operation.id, { checked: false });
        } else if (operation.action === "press") {
          const key = boundedString(operation.value, `UI batch operation ${JSON.stringify(operation.id)} key`, 100);
          await locator.press(key);
          results.set(operation.id, { pressed: key });
        } else {
          results.set(operation.id, await readLocatorWhen(locator, operation.value, operation.id));
        }
        if (!READ_ACTIONS.has(operation.action)) needsSettle = true;
      } catch (error) {
        throw new Error(
          `UI batch operation ${JSON.stringify(operation.id)} (${operation.action}) failed: ${error?.message || error}`,
        );
      } finally {
        const result = results.get(operation.id);
        if (result) result.durationMs = Date.now() - operationStartedAt;
      }
    }
    const ui = options.returnDirectory && hasWrites
      ? await refreshedActionDirectory(page, options.directoryWaitMs, activity)
      : undefined;
    const outcome: any = {
      protocol: "ui-batch/1",
      pageUpdated: hasWrites,
      durationMs: Date.now() - startedAt,
      results: Object.fromEntries(results),
    };
    if (ui) outcome.ui = ui;
    return outcome;
  } finally {
    page.off("request", requestStarted);
    page.off("requestfinished", requestEnded);
    page.off("requestfailed", requestEnded);
  }
}
