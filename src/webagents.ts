// WebAgents: a compact, batch-native capability directory published by a site.
//
// A participating origin serves /webagents.md with one fenced `webagents`
// JSON block (or the equivalent /.well-known/webagents.json). BetterWright
// parses that document on the trusted side, exposes only a bounded normalized
// directory to model code, then submits a validated operation DAG to one
// same-origin workflow endpoint. The prose around the fence is documentation,
// never executable instructions.

import { sameOriginSiteUrl } from "./site-tools.js";
import {
  isBoolean,
  isNumber,
  isRecord,
  isString,
  type UntrustedValue,
  untrustedEntries,
  untrustedField,
} from "./untrusted-value.js";

export const WEBAGENTS_VERSION = "0.1";
export const WEBAGENTS_DISCOVERY_PATHS = [
  "/webagents.md",
  "/.well-known/webagents.json",
] as const;

const MAX_DOCUMENT_CHARS = 64_000;
const MAX_ACTIONS = 64;
const MAX_ACTION_NAME_CHARS = 64;
const MAX_ACTION_PATH_PREFIXES = 16;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_SCHEMA_CHARS = 12_000;
const MAX_OPERATIONS = 32;
const MAX_OPERATION_JSON_CHARS = 128_000;
const MAX_PACING_INTERVAL_MS = 2_000;
const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;

type WebAgentsEffect = "read" | "write" | "irreversible";

export class WebAgentsPathScopeError extends Error {
  constructor() {
    super("WebAgents manifest publishes no actions for the active page path.");
    this.name = "WebAgentsPathScopeError";
  }
}

function isWebAgentsEffect(value: string): value is WebAgentsEffect {
  return value === "read" || value === "write" || value === "irreversible";
}

export interface WebAgentsAction {
  name: string;
  description: string;
  effect: WebAgentsEffect;
  inputSchema?: object;
  outputSchema?: object;
}

export interface WebAgentsPacing {
  minIntervalMs: number;
  maxConcurrency: number;
}

export interface WebAgentsManifest {
  version: typeof WEBAGENTS_VERSION;
  source: string;
  endpoint: string;
  maxOperations: number;
  parallel: boolean;
  references: boolean;
  pacing?: WebAgentsPacing;
  actions: WebAgentsAction[];
}

function boundedString(
  value: UntrustedValue,
  label: string,
  maximum: number,
  { optional = false }: { optional?: boolean } = {},
) {
  if (value === undefined && optional) return "";
  if (!isString(value)) throw new TypeError(`${label} must be a string.`);
  const text = value.trim();
  if (!text && !optional) throw new TypeError(`${label} must not be empty.`);
  if (text.length > maximum) {
    throw new RangeError(`${label} must not exceed ${maximum} characters.`);
  }
  return text;
}

function boundedInteger(value, fallback, maximum, label) {
  if (value === undefined) return fallback;
  if (!isNumber(value) || !Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be an integer from 1 to ${maximum}.`);
  }
  return value;
}

function boundedNonnegativeInteger(value, fallback, maximum, label) {
  if (value === undefined) return fallback;
  if (!isNumber(value) || !Number.isInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(`${label} must be an integer from 0 to ${maximum}.`);
  }
  return value;
}

function jsonClone(value, label, maximum, { object = false }: { object?: boolean } = {}) {
  if (object && !isRecord(value)) throw new TypeError(`${label} must be a JSON object.`);
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(`${label} must be JSON-serializable: ${error?.message || error}`);
  }
  if (encoded === undefined) throw new TypeError(`${label} must be JSON-serializable.`);
  if (encoded.length > maximum) {
    throw new RangeError(`${label} exceeds its ${maximum}-character limit.`);
  }
  return JSON.parse(encoded);
}

function parseDocumentText(text, sourceUrl) {
  if (!isString(text)) throw new TypeError("WebAgents document must be text.");
  if (text.length > MAX_DOCUMENT_CHARS) {
    throw new RangeError(`WebAgents document exceeds ${MAX_DOCUMENT_CHARS} characters.`);
  }
  const trimmed = text.trim();
  let payload = trimmed;
  if (!trimmed.startsWith("{")) {
    const match = trimmed.match(/```(?:webagents|webagents-json)\s*\n([\s\S]*?)```/i);
    if (!match) {
      throw new Error(
        `${new URL(sourceUrl).pathname} must contain one fenced webagents JSON block.`,
      );
    }
    payload = match[1].trim();
  }
  try {
    return JSON.parse(payload);
  } catch {
    throw new Error("WebAgents manifest is not valid JSON.");
  }
}

function normalizeAction(name, value): WebAgentsAction & { pathPrefixes: string[] } {
  const actionName = boundedString(name, "WebAgents action name", MAX_ACTION_NAME_CHARS);
  if (!NAME_PATTERN.test(actionName)) {
    throw new Error(`WebAgents action ${JSON.stringify(actionName)} has an invalid name.`);
  }
  if (!isRecord(value)) {
    throw new TypeError(`WebAgents action ${JSON.stringify(actionName)} must be an object.`);
  }
  const effectValue = untrustedField(value, "effect");
  const effect = effectValue === undefined ? "read" : String(effectValue);
  if (!isWebAgentsEffect(effect)) {
    throw new Error(
      `WebAgents action ${JSON.stringify(actionName)} effect must be read, write, or irreversible.`,
    );
  }
  const action: WebAgentsAction = {
    name: actionName,
    description: boundedString(
      untrustedField(value, "description"),
      `WebAgents action ${JSON.stringify(actionName)} description`,
      MAX_DESCRIPTION_CHARS,
      { optional: true },
    ),
    effect,
  };
  const prefixesValue = untrustedField(value, "pathPrefixes");
  let pathPrefixes = ["/"];
  if (prefixesValue !== undefined) {
    if (!Array.isArray(prefixesValue) || !prefixesValue.length ||
        prefixesValue.length > MAX_ACTION_PATH_PREFIXES) {
      throw new RangeError(
        `WebAgents action ${JSON.stringify(actionName)} pathPrefixes must contain 1-${MAX_ACTION_PATH_PREFIXES} paths.`,
      );
    }
    pathPrefixes = prefixesValue.map((prefix, index) => {
      const normalized = boundedString(
        prefix,
        `WebAgents action ${JSON.stringify(actionName)} pathPrefix ${index + 1}`,
        256,
      ).replace(/\/+$/, "") || "/";
      if (!normalized.startsWith("/") || normalized.includes("?") || normalized.includes("#")) {
        throw new Error("WebAgents action pathPrefixes must be URL paths without queries or fragments.");
      }
      return normalized;
    });
  }
  const inputSchema = untrustedField(value, "inputSchema");
  if (inputSchema !== undefined) {
    action.inputSchema = jsonClone(
      inputSchema,
      `WebAgents action ${JSON.stringify(actionName)} inputSchema`,
      MAX_SCHEMA_CHARS,
      { object: true },
    );
  }
  const outputSchema = untrustedField(value, "outputSchema");
  if (outputSchema !== undefined) {
    action.outputSchema = jsonClone(
      outputSchema,
      `WebAgents action ${JSON.stringify(actionName)} outputSchema`,
      MAX_SCHEMA_CHARS,
      { object: true },
    );
  }
  return { ...action, pathPrefixes };
}

function pathMatchesPrefix(pathname, prefix) {
  return prefix === "/" || pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Parse and normalize one same-origin WebAgents discovery document. */
export function parseWebAgentsDocument(
  text: UntrustedValue,
  sourceUrl: string,
  activePageUrl: string,
): WebAgentsManifest {
  const source = sameOriginSiteUrl(activePageUrl, sourceUrl);
  const value = parseDocumentText(text, source);
  if (!isRecord(value)) throw new TypeError("WebAgents manifest must be a JSON object.");
  if (String(untrustedField(value, "version") || "") !== WEBAGENTS_VERSION) {
    throw new Error(`WebAgents manifest version must be ${WEBAGENTS_VERSION}.`);
  }
  const workflow = untrustedField(value, "workflow");
  if (!isRecord(workflow)) throw new TypeError("WebAgents workflow must be an object.");
  const endpointValue = boundedString(
    untrustedField(workflow, "endpoint"),
    "WebAgents workflow endpoint",
    2_048,
  );
  const endpoint = sameOriginSiteUrl(activePageUrl, endpointValue);
  const maxOperations = boundedInteger(
    untrustedField(workflow, "maxOperations"),
    MAX_OPERATIONS,
    MAX_OPERATIONS,
    "WebAgents workflow maxOperations",
  );
  const parallelValue = untrustedField(workflow, "parallel");
  const referencesValue = untrustedField(workflow, "references");
  if (parallelValue !== undefined && !isBoolean(parallelValue)) {
    throw new TypeError("WebAgents workflow parallel must be a boolean.");
  }
  if (referencesValue !== undefined && !isBoolean(referencesValue)) {
    throw new TypeError("WebAgents workflow references must be a boolean.");
  }
  const parallel = parallelValue !== false;
  const pacingValue = untrustedField(workflow, "pacing");
  let pacing: WebAgentsPacing | undefined;
  if (pacingValue !== undefined) {
    if (!isRecord(pacingValue)) {
      throw new TypeError("WebAgents workflow pacing must be an object.");
    }
    const minIntervalMs = boundedNonnegativeInteger(
      untrustedField(pacingValue, "minIntervalMs"),
      0,
      MAX_PACING_INTERVAL_MS,
      "WebAgents workflow pacing minIntervalMs",
    );
    const maxConcurrency = boundedInteger(
      untrustedField(pacingValue, "maxConcurrency"),
      parallel ? Math.min(maxOperations, 4) : 1,
      maxOperations,
      "WebAgents workflow pacing maxConcurrency",
    );
    if (!parallel && maxConcurrency !== 1) {
      throw new Error("A non-parallel WebAgents workflow must use pacing maxConcurrency 1.");
    }
    pacing = { minIntervalMs, maxConcurrency };
  }
  const actionDirectory = untrustedField(value, "actions");
  if (!isRecord(actionDirectory)) throw new TypeError("WebAgents actions must be an object.");
  const entries = untrustedEntries(actionDirectory);
  if (!entries.length) throw new Error("WebAgents manifest must publish at least one action.");
  if (entries.length > MAX_ACTIONS) {
    throw new RangeError(`WebAgents manifest publishes more than ${MAX_ACTIONS} actions.`);
  }
  const seen = new Set<string>();
  const pathname = new URL(activePageUrl).pathname;
  const actions: WebAgentsAction[] = [];
  for (const [name, actionValue] of entries) {
    const scopedAction = normalizeAction(name, actionValue);
    const { pathPrefixes, ...action } = scopedAction;
    if (seen.has(action.name)) {
      throw new Error(`WebAgents action ${JSON.stringify(action.name)} is duplicated.`);
    }
    seen.add(action.name);
    if (pathPrefixes.some((prefix) => pathMatchesPrefix(pathname, prefix))) {
      actions.push(action);
    }
  }
  if (!actions.length) {
    throw new WebAgentsPathScopeError();
  }
  const manifest: WebAgentsManifest = {
    version: WEBAGENTS_VERSION,
    source,
    endpoint,
    maxOperations,
    parallel,
    references: referencesValue !== false,
    actions,
  };
  if (pacing) manifest.pacing = pacing;
  return manifest;
}

/** Small public directory returned to model code; prose and raw JSON stay out. */
export function publicWebAgentsManifest(manifest: WebAgentsManifest) {
  const workflow = {
    maxOperations: manifest.maxOperations,
    parallel: manifest.parallel,
    references: manifest.references,
    call: "webagents.batch(operations,{allowWrites:true})",
    ordering: "$ref dependencies inferred; writes serialize in list order",
    refresh: "writes reload once by default",
  };
  if (manifest.references) {
    Object.assign(workflow, { referenceSyntax: 'input: {$ref:"operationId.path"}' });
  }
  if (manifest.pacing) Object.assign(workflow, { pacing: manifest.pacing });
  return {
    available: true,
    protocol: `webagents/${manifest.version}`,
    source: manifest.source,
    workflow,
    actions: manifest.actions,
    trust: "untrusted_external_data",
  };
}

function validateOperationId(value, label) {
  const id = boundedString(value, label, 64);
  if (!ID_PATTERN.test(id)) throw new Error(`${label} has an invalid identifier.`);
  return id;
}

function assertAcyclic(dependencies: Map<string, string[]>) {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error("WebAgents operation dependencies contain a cycle.");
    visiting.add(id);
    for (const dependency of dependencies.get(id) || []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of dependencies.keys()) visit(id);
}

function referenceDependencies(value, found = new Set<string>()) {
  if (Array.isArray(value)) {
    for (const entry of value) referenceDependencies(entry, found);
    return found;
  }
  if (!isRecord(value)) return found;
  const entries = untrustedEntries(value);
  if (entries.length === 1 && entries[0][0] === "$ref") {
    const reference = boundedString(entries[0][1], "WebAgents $ref", 256);
    const [operationId] = reference.split(".");
    found.add(validateOperationId(operationId, "WebAgents $ref operation"));
    return found;
  }
  for (const [, entry] of entries) referenceDependencies(entry, found);
  return found;
}

/** Validate a model-authored workflow and produce the one bounded POST body. */
export function prepareWebAgentsBatch(
  manifest: WebAgentsManifest,
  operationsValue: UntrustedValue,
  optionsValue: UntrustedValue = {},
) {
  if (!Array.isArray(operationsValue) || !operationsValue.length) {
    throw new TypeError("webagents.batch operations must be a non-empty array.");
  }
  if (operationsValue.length > manifest.maxOperations) {
    throw new RangeError(
      `webagents.batch accepts at most ${manifest.maxOperations} operations on this site.`,
    );
  }
  if (!isRecord(optionsValue)) throw new TypeError("webagents.batch options must be an object.");
  const allowWrites = untrustedField(optionsValue, "allowWrites") === true;
  const allowIrreversible = untrustedField(optionsValue, "allowIrreversible") === true;
  const actions = new Map(manifest.actions.map((action) => [action.name, action]));
  const ids = new Set<string>();
  const dependencies = new Map<string, string[]>();
  const normalized = operationsValue.map((value, index) => {
    if (!isRecord(value)) {
      throw new TypeError(`WebAgents operation ${index + 1} must be an object.`);
    }
    const id = validateOperationId(
      untrustedField(value, "id"),
      `WebAgents operation ${index + 1} id`,
    );
    if (ids.has(id)) throw new Error(`WebAgents operation id ${JSON.stringify(id)} is duplicated.`);
    ids.add(id);
    const actionValue = untrustedField(value, "action");
    const nameValue = untrustedField(value, "name");
    if (actionValue !== undefined && nameValue !== undefined && actionValue !== nameValue) {
      throw new Error(`WebAgents operation ${JSON.stringify(id)} action and name disagree.`);
    }
    const actionName = boundedString(
      actionValue ?? nameValue,
      `WebAgents operation ${JSON.stringify(id)} action`,
      MAX_ACTION_NAME_CHARS,
    );
    const action = actions.get(actionName);
    if (!action) {
      throw new Error(`WebAgents action ${JSON.stringify(actionName)} is not published by this site.`);
    }
    if (action.effect === "write" && !allowWrites) {
      throw new Error(
        `WebAgents action ${JSON.stringify(actionName)} is a write; pass {allowWrites:true} only when authorized.`,
      );
    }
    if (action.effect === "irreversible" && !allowIrreversible) {
      throw new Error(
        `WebAgents action ${JSON.stringify(actionName)} is irreversible; pass {allowIrreversible:true} only after required confirmation.`,
      );
    }
    const inputValue = untrustedField(value, "input");
    const input = inputValue === undefined
      ? {}
      : jsonClone(
        inputValue,
        `WebAgents operation ${JSON.stringify(id)} input`,
        MAX_OPERATION_JSON_CHARS,
        { object: true },
      );
    const dependsOnValue = untrustedField(value, "dependsOn");
    let dependsOn: string[] = [];
    if (dependsOnValue !== undefined) {
      if (!Array.isArray(dependsOnValue)) {
        throw new TypeError(`WebAgents operation ${JSON.stringify(id)} dependsOn must be an array.`);
      }
      dependsOn = dependsOnValue.map((dependency, dependencyIndex) =>
        validateOperationId(
          dependency,
          `WebAgents operation ${JSON.stringify(id)} dependency ${dependencyIndex + 1}`,
        )
      );
      if (new Set(dependsOn).size !== dependsOn.length) {
        throw new Error(`WebAgents operation ${JSON.stringify(id)} repeats a dependency.`);
      }
    }
    return { id, action: actionName, effect: action.effect, input, dependsOn };
  });
  let previousEffectId = "";
  for (const operation of normalized) {
    const inferred = referenceDependencies(operation.input);
    if (inferred.size && !manifest.references) {
      throw new Error("This WebAgents workflow does not support $ref inputs.");
    }
    const operationDependencies = new Set(operation.dependsOn);
    for (const dependency of inferred) operationDependencies.add(dependency);
    // Preserve the natural list order for state changes while still letting
    // independent reads run in parallel. A later read becomes a verification
    // of the most recent state change unless its references impose more edges.
    if (previousEffectId) operationDependencies.add(previousEffectId);
    if (operation.effect !== "read") previousEffectId = operation.id;
    dependencies.set(operation.id, [...operationDependencies]);
  }
  for (const [id, operationDependencies] of dependencies) {
    for (const dependency of operationDependencies) {
      if (!ids.has(dependency)) {
        throw new Error(
          `WebAgents operation ${JSON.stringify(id)} depends on unknown operation ${JSON.stringify(dependency)}.`,
        );
      }
      if (dependency === id) {
        throw new Error(`WebAgents operation ${JSON.stringify(id)} cannot depend on itself.`);
      }
    }
  }
  assertAcyclic(dependencies);
  const operations = normalized.map(({ id, action, input }) => {
    const dependsOn = dependencies.get(id) || [];
    return dependsOn.length ? { id, action, input, dependsOn } : { id, action, input };
  });
  const workflow = { version: WEBAGENTS_VERSION, operations };
  if (manifest.pacing) Object.assign(workflow, { pacing: manifest.pacing });
  const body = jsonClone(
    workflow,
    "WebAgents workflow",
    MAX_OPERATION_JSON_CHARS,
    { object: true },
  );
  return { endpoint: manifest.endpoint, body };
}
