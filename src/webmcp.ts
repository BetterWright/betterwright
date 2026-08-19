// WebMCP: typed, first-party tools registered by the current web page.
//
// Chromium exposes these tools through its privileged WebMCP DevTools domain,
// not through a page-world API. BetterWright keeps that channel on the trusted
// side of the worker just like screenshots, credential capture, and the guard
// proxy: model code can list and invoke page tools, but it never receives a
// CDP session or a raw browser handle.

import {
  isBoolean,
  isCallable,
  isNumber,
  isRecord,
  isString,
  type UntrustedValue,
  untrustedField,
} from "./untrusted-value.js";

export const WEBMCP_FEATURE_SWITCH =
  "--enable-features=WebMCPTesting,DevToolsWebMCPSupport";

const DEFAULT_DISCOVERY_TIMEOUT_MS = 1_000;
const DEFAULT_INVOCATION_TIMEOUT_MS = 30_000;
const MAX_DISCOVERY_TIMEOUT_MS = 10_000;
const MAX_INVOCATION_TIMEOUT_MS = 120_000;
const MAX_TOOLS = 256;
const MAX_TOOL_NAME_CHARS = 256;
const MAX_TOOL_DESCRIPTION_CHARS = 10_000;
const MAX_WEBMCP_JSON_CHARS = 1_000_000;
const TOOLS_QUIET_WINDOW_MS = 100;

interface WebMCPAnnotations {
  readOnly?: boolean;
  untrustedContent?: boolean;
  autosubmit?: boolean;
}

interface WebMCPToolDescriptor {
  name: string;
  description: string;
  frameId: string;
  trust: "untrusted_external_data";
  inputSchema?: object;
  annotations?: WebMCPAnnotations;
  backendNodeId?: number;
}

interface WebMCPTerminalResponse {
  invocationId: string;
  status: string;
  output?: UntrustedValue;
  errorText?: string;
  exception?: UntrustedValue;
}

function isCDPSessionFactory(
  value: UntrustedValue,
): value is (page: any) => Promise<any> {
  return isCallable(value);
}

function timeoutMs(value, fallback, maximum, label) {
  const resolved = value === undefined ? fallback : value;
  if (!isNumber(resolved) || !Number.isFinite(resolved) || resolved < 0) {
    throw new TypeError(`${label} must be a non-negative finite number.`);
  }
  if (resolved > maximum) {
    throw new RangeError(`${label} must not exceed ${maximum}ms.`);
  }
  return resolved;
}

function boundedString(value, label, maximum, { optional = false }: any = {}) {
  if (value === undefined && optional) return undefined;
  if (!isString(value)) throw new TypeError(`${label} must be a string.`);
  const text = value.trim();
  if (!text && !optional) throw new TypeError(`${label} must not be empty.`);
  if (text.length > maximum) {
    throw new RangeError(`${label} must not exceed ${maximum} characters.`);
  }
  return text;
}

function jsonClone(value, label, { object = false }: any = {}) {
  if (object && !isRecord(value)) {
    throw new TypeError(`${label} must be a JSON object.`);
  }
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (error) {
    throw new TypeError(
      `${label} must be JSON-serializable: ${error?.message || error}`,
    );
  }
  if (encoded === undefined) {
    throw new TypeError(`${label} must be JSON-serializable.`);
  }
  if (encoded.length > MAX_WEBMCP_JSON_CHARS) {
    throw new RangeError(
      `${label} is ${encoded.length} characters; the limit is ${MAX_WEBMCP_JSON_CHARS}.`,
    );
  }
  return JSON.parse(encoded);
}

function annotationObject(value) {
  if (!isRecord(value)) return undefined;
  const annotations: WebMCPAnnotations = {};
  for (const name of ["readOnly", "untrustedContent", "autosubmit"]) {
    const entry = untrustedField(value, name);
    if (isBoolean(entry)) annotations[name] = entry;
  }
  return Object.keys(annotations).length ? annotations : undefined;
}

function normalizeTool(value) {
  if (!isRecord(value)) return null;
  let name;
  let description;
  let frameId;
  try {
    name = boundedString(
      untrustedField(value, "name"),
      "WebMCP tool name",
      MAX_TOOL_NAME_CHARS,
    );
    description = boundedString(
      untrustedField(value, "description"),
      `WebMCP tool ${JSON.stringify(name)} description`,
      MAX_TOOL_DESCRIPTION_CHARS,
      { optional: true },
    ) || "";
    frameId = boundedString(
      untrustedField(value, "frameId"),
      `WebMCP tool ${JSON.stringify(name)} frameId`,
      MAX_TOOL_NAME_CHARS,
    );
  } catch {
    return null;
  }
  const descriptor: WebMCPToolDescriptor = {
    name,
    description,
    frameId,
    trust: "untrusted_external_data",
  };
  const inputSchema = untrustedField(value, "inputSchema");
  if (inputSchema !== undefined) {
    try {
      descriptor.inputSchema = jsonClone(
        inputSchema,
        `WebMCP tool ${JSON.stringify(name)} inputSchema`,
        { object: true },
      );
    } catch {
      return null;
    }
  }
  const annotations = annotationObject(untrustedField(value, "annotations"));
  if (annotations) descriptor.annotations = annotations;
  const backendNodeId = untrustedField(value, "backendNodeId");
  if (isNumber(backendNodeId) && Number.isInteger(backendNodeId) && backendNodeId >= 0) {
    descriptor.backendNodeId = backendNodeId;
  }
  return descriptor;
}

function normalizeTerminalResponse(value, invocationId) {
  if (!isRecord(value) || String(untrustedField(value, "invocationId") || "") !== invocationId) {
    return null;
  }
  const status = untrustedField(value, "status");
  if (!["Completed", "Canceled", "Error"].includes(String(status))) return null;
  const response: WebMCPTerminalResponse = {
    invocationId,
    status: String(status),
  };
  const output = untrustedField(value, "output");
  if (output !== undefined) response.output = jsonClone(output, "WebMCP tool output");
  const errorText = untrustedField(value, "errorText");
  if (isString(errorText)) {
    response.errorText = errorText.slice(0, MAX_TOOL_DESCRIPTION_CHARS);
  }
  const exception = untrustedField(value, "exception");
  if (exception !== undefined) {
    response.exception = jsonClone(exception, "WebMCP tool exception");
  }
  return response;
}

function unsupportedError(error) {
  const detail = String(error?.message || error || "");
  if (!/WebMCP|method (?:was )?not found|-32601/i.test(detail)) return error;
  return new Error(
    "WebMCP is unavailable in this browser. BetterWright enables it for local " +
      "launches; an attached or cloud browser must be started with " +
      `${WEBMCP_FEATURE_SWITCH}.`,
    { cause: error },
  );
}

async function collectTools(cdp, timeout) {
  const tools = new Map();
  let changedAt = 0;
  let wake = null;
  const signalChange = () => {
    changedAt = Date.now();
    wake?.();
  };
  const onAdded = (event) => {
    const entries = Array.isArray(event?.tools) ? event.tools : [];
    for (const entry of entries) {
      const tool = normalizeTool(entry);
      if (!tool) continue;
      const key = `${tool.frameId}\u0000${tool.name}`;
      if (!tools.has(key) && tools.size >= MAX_TOOLS) continue;
      tools.set(key, tool);
    }
    if (entries.length) signalChange();
  };
  const onRemoved = (event) => {
    const entries = Array.isArray(event?.tools) ? event.tools : [];
    let changed = false;
    for (const entry of entries) {
      const frameId = String(entry?.frameId || "");
      const name = String(entry?.name || "");
      if (frameId && name) changed = tools.delete(`${frameId}\u0000${name}`) || changed;
    }
    if (changed) signalChange();
  };

  cdp.on("WebMCP.toolsAdded", onAdded);
  cdp.on("WebMCP.toolsRemoved", onRemoved);
  try {
    try {
      await cdp.send("WebMCP.enable");
    } catch (error) {
      throw unsupportedError(error);
    }
    if (timeout === 0) return [...tools.values()];
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const quietRemaining = changedAt
        ? Math.max(0, TOOLS_QUIET_WINDOW_MS - (Date.now() - changedAt))
        : TOOLS_QUIET_WINDOW_MS;
      if (quietRemaining === 0) break;
      const outcome = await new Promise((resolve) => {
        const timer = setTimeout(
          () => resolve("quiet"),
          Math.min(quietRemaining, deadline - Date.now()),
        );
        wake = () => {
          clearTimeout(timer);
          resolve("changed");
        };
      });
      wake = null;
      if (outcome === "quiet") break;
    }
    return [...tools.values()];
  } finally {
    wake = null;
    cdp.off("WebMCP.toolsAdded", onAdded);
    cdp.off("WebMCP.toolsRemoved", onRemoved);
  }
}

async function withCDPSession(page, newCDPSession, operation) {
  if (!isCDPSessionFactory(newCDPSession)) {
    throw new Error("WebMCP requires the worker's privileged CDP bridge.");
  }
  const cdp = await newCDPSession(page);
  try {
    return await operation(cdp);
  } finally {
    if (isCallable(untrustedField(cdp, "detach"))) await cdp.detach().catch(() => {});
  }
}

/** Return a fresh snapshot of tools registered by the current page and frames. */
export async function listWebMCPTools(
  page,
  { newCDPSession, timeout }: any = {},
) {
  const discoveryTimeout = timeoutMs(
    timeout,
    DEFAULT_DISCOVERY_TIMEOUT_MS,
    MAX_DISCOVERY_TIMEOUT_MS,
    "webmcp.tools timeout",
  );
  return withCDPSession(page, newCDPSession, (cdp) =>
    collectTools(cdp, discoveryTimeout)
  );
}

function resolveTool(tools, name, frameId) {
  const matching = tools.filter(
    (tool) => tool.name === name && (!frameId || tool.frameId === frameId),
  );
  if (!matching.length) {
    const suffix = frameId ? ` in frame ${JSON.stringify(frameId)}` : "";
    throw new Error(`WebMCP tool ${JSON.stringify(name)} is not registered${suffix}.`);
  }
  if (matching.length > 1) {
    const frames = matching.map((tool) => tool.frameId).join(", ");
    throw new Error(
      `WebMCP tool ${JSON.stringify(name)} is registered in multiple frames (${frames}); ` +
        "pass {frameId} from webmcp.tools().",
    );
  }
  return matching[0];
}

/**
 * Invoke one freshly discovered page tool and await its terminal result.
 *
 * Unlike the raw two-stage protocol, a timed-out BetterWright invocation is
 * canceled before the privileged session is detached, so page work is not
 * deliberately left running after the caller has given up.
 */
export async function invokeWebMCPTool(
  page,
  nameValue,
  inputValue = {},
  options: any = {},
  { newCDPSession }: any = {},
) {
  const name = boundedString(
    nameValue,
    "webmcp.invoke tool name",
    MAX_TOOL_NAME_CHARS,
  );
  const input = jsonClone(inputValue, "webmcp.invoke input", { object: true });
  if (!isRecord(options)) throw new TypeError("webmcp.invoke options must be an object.");
  const frameIdValue = untrustedField(options, "frameId");
  const frameId = frameIdValue === undefined
    ? undefined
    : boundedString(
        frameIdValue,
        "webmcp.invoke frameId",
        MAX_TOOL_NAME_CHARS,
      );
  const discoveryTimeout = timeoutMs(
    untrustedField(options, "discoveryTimeout"),
    DEFAULT_DISCOVERY_TIMEOUT_MS,
    MAX_DISCOVERY_TIMEOUT_MS,
    "webmcp.invoke discoveryTimeout",
  );
  const invocationTimeout = timeoutMs(
    untrustedField(options, "timeout"),
    DEFAULT_INVOCATION_TIMEOUT_MS,
    MAX_INVOCATION_TIMEOUT_MS,
    "webmcp.invoke timeout",
  );
  const allowAutosubmit = untrustedField(options, "allowAutosubmit") === true;

  return withCDPSession(page, newCDPSession, async (cdp) => {
    const tools = await collectTools(cdp, discoveryTimeout);
    const tool = resolveTool(tools, name, frameId);
    if (tool.annotations?.autosubmit === true && !allowAutosubmit) {
      throw new Error(
        `WebMCP tool ${JSON.stringify(name)} declares autosubmit=true. ` +
          "Pass {allowAutosubmit:true} only when the user's request authorizes submission.",
      );
    }

    let expectedInvocationId = "";
    let resolveTerminal;
    const earlyResponses = new Map();
    const terminal = new Promise((resolve) => {
      resolveTerminal = resolve;
    });
    const onResponded = (event) => {
      const id = String(event?.invocationId || "");
      if (!id) return;
      if (id === expectedInvocationId) resolveTerminal(event);
      else earlyResponses.set(id, event);
    };
    cdp.on("WebMCP.toolResponded", onResponded);
    let invocationId = "";
    try {
      const response = await cdp.send("WebMCP.invokeTool", {
        frameId: tool.frameId,
        toolName: tool.name,
        input,
      });
      invocationId = boundedString(
        response?.invocationId,
        "WebMCP invocationId",
        MAX_TOOL_NAME_CHARS,
      );
      expectedInvocationId = invocationId;
      if (earlyResponses.has(invocationId)) {
        resolveTerminal(earlyResponses.get(invocationId));
      }

      let timer;
      const timedOut = new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(
            `WebMCP tool ${JSON.stringify(name)} timed out after ${invocationTimeout}ms.`,
          )),
          invocationTimeout,
        );
      });
      let rawResult;
      try {
        rawResult = await Promise.race([terminal, timedOut]);
      } catch (error) {
        await cdp.send("WebMCP.cancelInvocation", { invocationId }).catch(() => {});
        throw error;
      } finally {
        clearTimeout(timer);
      }
      const result = normalizeTerminalResponse(rawResult, invocationId);
      if (!result) {
        throw new Error(
          `WebMCP tool ${JSON.stringify(name)} returned an invalid terminal response.`,
        );
      }
      return {
        tool,
        ...result,
        // Tool results are page-controlled even when the page omits the
        // advisory untrustedContent annotation. Keep that fact attached to the
        // value instead of relying on every downstream prompt to remember it.
        trust: "untrusted_external_data",
      };
    } finally {
      cdp.off("WebMCP.toolResponded", onResponded);
      earlyResponses.clear();
    }
  });
}
