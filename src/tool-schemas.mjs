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

import { VAULT_MATCH_MODES } from "./vault.mjs";

// Selector fields state only their target; the "CSS or current aria-ref=eN"
// convention lives once in each surface's tool description, not per field.

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

export function mcpLoginInputSchema() {
  const properties = loginToolProperties();
  properties.submit = { ...properties.submit, default: false };
  properties.generate = { ...properties.generate, default: false };
  properties.session = sessionProperty();
  return { type: "object", properties };
}

// --- Pi extension (Pi tool parameters shape) -------------------------------
// Pi validates arguments against the schema, so it pins additionalProperties
// and rejects empty required inputs.

export function piBrowserToolParameters() {
  const properties = browserToolProperties();
  properties.code = { ...properties.code, minLength: 1 };
  return {
    type: "object",
    additionalProperties: false,
    properties,
    required: ["code"],
  };
}

export function piLoginToolParameters() {
  const properties = loginToolProperties();
  properties.passwordSelector = { ...properties.passwordSelector, minLength: 1 };
  return { type: "object", additionalProperties: false, properties };
}
