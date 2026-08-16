// Credential constants shared by the client and the worker, which run in
// separate processes. This module is the single source of truth for values
// both sides must agree on; it stays dependency-free so either side can
// import it without pulling in the vault or browser runtime.

// Type-only, so the compiled module keeps zero runtime dependencies.
import type { UntrustedValue } from "./untrusted-value.js";

export const REDACTED_PASSWORD_PLACEHOLDER = "[REDACTED_PASSWORD]";

// Local copies of the shared guards: importing their runtime implementations
// would break this module's dependency-freedom (see the header).
function isString(value: UntrustedValue): value is string {
  return typeof value === "string";
}

/** Anything redaction/recovery must walk into: a non-null object or array. */
function isContainer(value: UntrustedValue): value is object {
  return value !== null && typeof value === "object";
}

/**
 * Deep-scrub every occurrence of the given secret strings from a value,
 * returning a redacted copy without mutating the input. This is the one
 * redaction algorithm: the worker's envelope redaction and the host vault's
 * `redact()` both delegate here so the two defense layers can never drift.
 * The rules are deliberate and security-relevant:
 * - secrets are replaced longest-first, so a secret that contains another
 *   secret is scrubbed whole instead of leaving a recognizable remainder;
 * - replacement uses split/join, so secrets are matched literally rather
 *   than as regular expressions;
 * - object keys are redacted as well as values, because a secret can leak
 *   through either position;
 * - cycles collapse to "[Circular]" so redaction terminates on any input.
 */
export function redactSecretsDeep(value, secrets) {
  const ordered = [...secrets]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  const redactText = (input) => {
    let output = String(input);
    for (const secret of ordered) {
      output = output.split(secret).join(REDACTED_PASSWORD_PLACEHOLDER);
    }
    return output;
  };
  const seen = new WeakSet();
  const redactValue = (input) => {
    if (isString(input)) return redactText(input);
    if (!isContainer(input)) return input;
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    if (Array.isArray(input)) return input.map(redactValue);
    const output: Record<string, UntrustedValue> = {};
    for (const [key, item] of Object.entries(input)) {
      output[redactText(key)] = redactValue(item);
    }
    return output;
  };
  return redactValue(value);
}

export const VAULT_MATCH_MODES = Object.freeze([
  "base-domain",
  "host",
  "exact-origin",
  "never",
]);

export const MAX_PENDING_CREDENTIAL_ORIGINS = 100;

const MATCH_MODE_SET = new Set(VAULT_MATCH_MODES);

export function validateCredentialMatchMode(value) {
  if (!isString(value) || !MATCH_MODE_SET.has(value)) {
    throw new TypeError(
      'matchMode must be "base-domain", "host", "exact-origin", or "never".',
    );
  }
  return value;
}

/**
 * Guard shared by every generate entry point: rotating an existing credential
 * (an explicit id) must keep the saved record's scope, so a matchMode override
 * is rejected before any secret is generated.
 */
export function assertRotationPreservesMatchMode(spec) {
  if (spec?.id != null && spec?.matchMode !== undefined) {
    throw new TypeError(
      "matchMode cannot be changed when rotating an existing credential; " +
        "omit matchMode to preserve the saved record scope.",
    );
  }
}

// Recovery consults `username`/`label` only through Object.hasOwn, so the
// claim is merely "an object whose fields are untrusted until coerced".
interface RecoverySource {
  username?: UntrustedValue;
  label?: UntrustedValue;
}

function isRecoverySource(value: UntrustedValue): value is RecoverySource {
  return value !== null && typeof value === "object";
}

/**
 * Build the recovery metadata for a generated-but-unfinalized credential.
 * `record` is the authoritative vault/session record and always wins;
 * `requested` is the original generate request, consulted only for fields the
 * record does not carry. Both the worker and the host client derive recovery
 * scope from this one implementation — it decides which origins a pending
 * credential can be finalized against, so any change here is a security
 * change.
 */
export function pendingCredentialRecovery(record, requested, origin) {
  const pendingId = String(record?.pendingId ?? "").trim();
  if (!pendingId) return null;
  const recordMatchMode = String(record?.matchMode ?? "").trim();
  const requestedMatchMode = String(requested?.matchMode ?? "").trim();
  const matchMode = MATCH_MODE_SET.has(recordMatchMode)
    ? recordMatchMode
    : MATCH_MODE_SET.has(requestedMatchMode)
      ? requestedMatchMode
      : "base-domain";
  const recordObject: RecoverySource = isRecoverySource(record) ? record : {};
  const requestedObject: RecoverySource = isRecoverySource(requested)
    ? requested
    : {};
  const username = Object.hasOwn(recordObject, "username")
    ? recordObject.username
    : Object.hasOwn(requestedObject, "username")
      ? requestedObject.username
      : null;
  const label = Object.hasOwn(recordObject, "label")
    ? recordObject.label
    : Object.hasOwn(requestedObject, "label")
      ? requestedObject.label
      : null;
  return {
    pendingId,
    // This is where the form was filled, not an existing record's saved scope.
    origin: String(origin),
    matchMode,
    username: username == null ? null : String(username),
    label: label == null ? null : String(label),
    expiresAt: record?.expiresAt == null ? null : String(record.expiresAt),
  };
}
