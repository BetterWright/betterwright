import { validateCredentialMatchMode } from "./credential-constants.js";

const STRING_OPTIONS = [
  "passwordSelector",
  "currentPasswordSelector",
  "usernameSelector",
  "confirmPasswordSelector",
  "submitSelector",
  "id",
  "username",
  "label",
];

/** Keep and normalize only the options accepted by trusted credential fills. */
export function normalizeCredentialToolOptions(input: any = {}, config: any = {}) {
  const source =
    input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const requestedSession =
    config.session === undefined ? source.session : config.session;
  const options: Record<string, any> = {
    session: String(requestedSession || "default"),
    generate: source.generate === true,
  };

  for (const key of STRING_OPTIONS) {
    if (source[key] != null) options[key] = String(source[key]);
  }
  if (source.length != null) options.length = Number(source.length);
  if (typeof source.includeSymbols === "boolean") {
    options.includeSymbols = source.includeSymbols;
  }
  if (source.matchMode !== undefined) {
    options.matchMode = validateCredentialMatchMode(source.matchMode);
  }
  if (typeof source.submit === "boolean") options.submit = source.submit;
  return options;
}
