// Single source of truth for the tool PARAMETER schemas shared by the three
// model-facing surfaces: the agent harness (Anthropic `input_schema` shape),
// the MCP server (JSON-Schema `inputSchema`), and the Pi extension (Pi tool
// `parameters`).
//
// Only what is mechanically the same lives here — property names, types, and
// field descriptions. Each surface builds its own envelope on top, because the
// envelopes genuinely differ: MCP adds a per-call `session` argument and
// JSON-Schema `default` hints, Pi validates arguments strictly
// (`additionalProperties: false`, non-empty inputs), and the agent harness
// keeps the minimal shape. Per-surface tool DESCRIPTIONS (the prose telling a
// model when to use the tool) stay in each surface on purpose — that is
// deliberate authorial voice per surface, not drift.
//
// Every builder returns fresh objects so a caller mutating its copy can never
// leak into another surface.

import { AGENT_BATCH_ACTIONS, MAX_AGENT_BATCH_STEPS } from "./agent-batch.js";
import { VAULT_MATCH_MODES } from "./vault.js";

// Selector fields state only their target; the "CSS or current aria-ref=eN"
// convention lives once in each surface's tool description, not per field.

/** One parameter's JSON-Schema fragment, the subset these builders emit. */
interface ToolPropertySchema {
  type?: string;
  description?: string;
  enum?: string[];
  default?: string | boolean;
  minLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: ToolPropertySchema;
  properties?: Record<string, ToolPropertySchema>;
  required?: string[];
  additionalProperties?: boolean;
}

export const SESSION_PROPERTY_DESCRIPTION =
  "Independent pages/state; reuse a name across calls.";

function sessionProperty() {
  return {
    type: "string",
    description: SESSION_PROPERTY_DESCRIPTION,
    default: "default",
  };
}

/** Shared field schemas for the browser (run-code) tool. */
export function browserToolProperties() {
  return {
    code: { type: "string" },
    note: {
      type: "string",
      description: "Present-tense status line (not code).",
    },
  };
}

/**
 * Shared field schemas for the AgentBatch tool. The step schema names every
 * field the executor accepts (src/agent-batch.ts rejects any other), so a
 * strict surface can pin additionalProperties without losing an action.
 */
export function batchToolProperties() {
  const step: ToolPropertySchema = {
    type: "object",
    properties: {
      action: { type: "string", enum: [...AGENT_BATCH_ACTIONS] },
      id: { type: "string" },
      target: {
        type: "object",
        description: "One of ref, role (+name), label, text, placeholder, testId, css; exact, nth, frameName refine.",
      },
      url: { type: "string" },
      value: { description: "fill/type text; select value(s)." },
      key: { type: "string" },
      expect: { type: "string", description: "read/url: substring to wait for." },
      text: { type: "string", description: "wait: visible text." },
      state: { type: "string", enum: ["attached", "detached", "visible", "hidden"] },
      ms: { type: "integer" },
      attribute: { type: "string" },
      all: { type: "boolean" },
      append: { type: "boolean" },
      dx: { type: "integer" },
      dy: { type: "integer" },
      waitUntil: { type: "string", enum: ["load", "domcontentloaded", "commit", "networkidle"] },
      interactive: { type: "boolean" },
      ref: { type: "string" },
      selector: { type: "string" },
      diff: { type: "boolean" },
      depth: { type: "integer" },
      maxChars: { type: "integer" },
      urls: { type: "boolean" },
      kind: { type: "string", enum: ["proof", "question", "debug"] },
      name: { type: "string" },
      fullPage: { type: "boolean" },
      annotate: { type: "boolean" },
      page: { description: "usePage/closePage: page id or index." },
      response: { type: "string", enum: ["accept", "dismiss"] },
      promptText: { type: "string" },
      optional: { type: "boolean" },
      irreversible: { type: "boolean" },
      timeoutMs: { type: "integer" },
    },
    required: ["action"],
  };
  return {
    url: { type: "string", description: "Spec call: open this URL; omit steps." },
    steps: {
      type: "array",
      minItems: 1,
      maxItems: MAX_AGENT_BATCH_STEPS,
      items: step,
    },
    allowWrites: { type: "boolean" },
    allowIrreversible: { type: "boolean" },
    allowPasswords: { type: "boolean" },
    observe: { type: "string", enum: ["snapshot", "diff", "none"] },
    proof: { type: "boolean" },
    answer: {
      type: "string",
      description: "Final answer to finish in this call; {stepId} / {stepId.field} fill from step results.",
    },
    note: {
      type: "string",
      description: "Present-tense status line.",
    },
  };
}

/** Shared field schemas for the credential login tool. */
export function loginToolProperties() {
  return {
    passwordSelector: { type: "string" },
    // The one field a model cannot infer from its name alone: this is the
    // *existing* password during a rotation, not the one being set.
    currentPasswordSelector: { type: "string", description: "Existing password field (rotation)." },
    usernameSelector: { type: "string", description: "Username/email field." },
    confirmPasswordSelector: { type: "string" },
    submitSelector: { type: "string" },
    submit: {
      type: "boolean",
      description: "Submit the form (default false).",
    },
    id: {
      type: "string",
      description: "Record to use; rotated when generate=true.",
    },
    username: {
      type: "string",
      description: "Record username, or the new one on signup.",
    },
    generate: { type: "boolean" },
    length: { type: "integer", description: "Password length (default 24)." },
    includeSymbols: {
      type: "boolean",
      description: "Include symbols (default true).",
    },
    label: { type: "string" },
    matchMode: {
      type: "string",
      enum: [...VAULT_MATCH_MODES],
      description: "Scope (default base-domain).",
    },
  };
}

// --- Agent harness (Anthropic input_schema shape) --------------------------
// The harness owns the session, so no session argument; minimal envelope.

export function agentBrowserToolParameters() {
  return { type: "object", properties: browserToolProperties(), required: ["code"] };
}

export function agentLoginToolParameters() {
  return { type: "object", properties: loginToolProperties() };
}

export function agentBatchToolParameters() {
  return { type: "object", properties: batchToolProperties() };
}

// --- MCP server (JSON-Schema inputSchema shape) ----------------------------
// MCP tool calls carry their own `session`, and MCP clients surface
// JSON-Schema `default` hints.

export function mcpRunInputSchema() {
  const { code, note } = browserToolProperties();
  return {
    type: "object",
    properties: {
      code,
      session: sessionProperty(),
      note: { ...note, default: "" },
    },
    required: ["code"],
  };
}

export function mcpBatchInputSchema() {
  const properties: Record<string, ToolPropertySchema> = batchToolProperties();
  properties.allowWrites = { ...properties.allowWrites, default: false };
  properties.allowIrreversible = { ...properties.allowIrreversible, default: false };
  properties.allowPasswords = { ...properties.allowPasswords, default: false };
  properties.observe = { ...properties.observe, default: "snapshot" };
  properties.proof = { ...properties.proof, default: false };
  properties.session = sessionProperty();
  properties.note = { ...properties.note, default: "" };
  return { type: "object", properties };
}

export function mcpLoginInputSchema() {
  const properties: Record<string, ToolPropertySchema> = loginToolProperties();
  properties.submit = { ...properties.submit, default: false };
  properties.generate = { ...properties.generate, default: false };
  properties.session = sessionProperty();
  return { type: "object", properties };
}

// --- Pi extension (Pi tool parameters shape) -------------------------------
// Pi validates arguments against the schema, so it pins additionalProperties
// and rejects empty required inputs.

export function piBrowserToolParameters() {
  const properties: Record<string, ToolPropertySchema> = browserToolProperties();
  properties.code = { ...properties.code, minLength: 1 };
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: ["code"],
  };
}

export function piBatchToolParameters() {
  const properties: Record<string, ToolPropertySchema> = batchToolProperties();
  properties.url = { ...properties.url, minLength: 1 };
  properties.steps = {
    ...properties.steps,
    items: { ...properties.steps.items, additionalProperties: false },
  };
  return { type: "object", additionalProperties: false, properties };
}

export function piLoginToolParameters() {
  const properties: Record<string, ToolPropertySchema> = loginToolProperties();
  properties.passwordSelector = { ...properties.passwordSelector, minLength: 1 };
  return { type: "object", additionalProperties: false, properties };
}
