// Credential constants shared by the client and the worker, which run in
// separate processes. This module is the single source of truth for values
// both sides must agree on; it stays dependency-free so either side can
// import it without pulling in the vault or browser runtime.

export const VAULT_MATCH_MODES = Object.freeze([
  "base-domain",
  "host",
  "exact-origin",
  "never",
]);

export const MAX_PENDING_CREDENTIAL_ORIGINS = 100;

const MATCH_MODE_SET = new Set(VAULT_MATCH_MODES);

export function validateCredentialMatchMode(value) {
  if (typeof value !== "string" || !MATCH_MODE_SET.has(value)) {
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
  const recordObject = record && typeof record === "object" ? record : {};
  const requestedObject =
    requested && typeof requested === "object" ? requested : {};
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
