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
