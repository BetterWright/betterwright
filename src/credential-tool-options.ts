import { validateCredentialMatchMode } from "./credential-constants.js";
import { isBoolean, isRecord, type UntrustedValue } from "./untrusted-value.js";

const STRING_OPTIONS = [
  "passwordSelector",
  "currentPasswordSelector",
  "usernameSelector",
  "confirmPasswordSelector",
  "submitSelector",
  "id",
  "username",
  "label",
] as const;

// The raw tool-call arguments: model-authored, so every field is untrusted
// until coerced below.
interface CredentialToolRequest {
  session?: UntrustedValue;
  generate?: UntrustedValue;
  passwordSelector?: UntrustedValue;
  currentPasswordSelector?: UntrustedValue;
  usernameSelector?: UntrustedValue;
  confirmPasswordSelector?: UntrustedValue;
  submitSelector?: UntrustedValue;
  id?: UntrustedValue;
  username?: UntrustedValue;
  label?: UntrustedValue;
  length?: UntrustedValue;
  includeSymbols?: UntrustedValue;
  matchMode?: UntrustedValue;
  submit?: UntrustedValue;
}

function isCredentialToolRequest(value: UntrustedValue): value is CredentialToolRequest {
  return isRecord(value);
}

interface CredentialToolOptions {
  session: string;
  generate: boolean;
  passwordSelector?: string;
  currentPasswordSelector?: string;
  usernameSelector?: string;
  confirmPasswordSelector?: string;
  submitSelector?: string;
  id?: string;
  username?: string;
  label?: string;
  length?: number;
  includeSymbols?: boolean;
  matchMode?: string;
  submit?: boolean;
}

/** Keep and normalize only the options accepted by trusted credential fills. */
export function normalizeCredentialToolOptions(input: any = {}, config: any = {}) {
  const source: CredentialToolRequest = isCredentialToolRequest(input) ? input : {};
  const requestedSession =
    config.session === undefined ? source.session : config.session;
  const options: CredentialToolOptions = {
    session: String(requestedSession || "default"),
    generate: source.generate === true,
  };

  for (const key of STRING_OPTIONS) {
    if (source[key] != null) options[key] = String(source[key]);
  }
  if (source.length != null) options.length = Number(source.length);
  if (isBoolean(source.includeSymbols)) {
    options.includeSymbols = source.includeSymbols;
  }
  if (source.matchMode !== undefined) {
    options.matchMode = validateCredentialMatchMode(source.matchMode);
  }
  if (isBoolean(source.submit)) options.submit = source.submit;
  return options;
}
