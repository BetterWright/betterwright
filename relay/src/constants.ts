export const API_KEY_PREFIX = "bw_live";
export const API_KEY_ID_BYTES = 12;
export const API_KEY_SECRET_BYTES = 32;
export const ROOT_KEY_BYTES = 32;
export const CAPABILITY_BYTES = 32;
export const SESSION_ID_BYTES = 18;
export const MAX_ACTIVE_API_KEYS = 5;

export const RELAY_PROTOCOL = "betterwright.relay.v1";
export const HOST_PROTOCOL_PREFIX = "bw.host.";
export const VIEWER_PROTOCOL_PREFIX = "bw.viewer.";

export const ENVELOPE_VERSION = 1;
export const ENVELOPE_DIRECTION = {
  HOST_TO_VIEWER: 1,
  VIEWER_TO_HOST: 2,
} as const;
export const ENVELOPE_EPOCH_BYTES = 16;
export const ENVELOPE_SEQUENCE_BYTES = 8;
export const ENVELOPE_NONCE_BYTES = 12;
export const ENVELOPE_HEADER_BYTES = 26;
export const ENVELOPE_TAG_BYTES = 16;
export const ENVELOPE_KIND = {
  TEXT: 0,
  BINARY: 1,
  CHALLENGE: 2,
} as const;

export const CLOSE_CODE = {
  SESSION_CLOSED: 4401,
  AUTH_FAILED: 4403,
  PEER_UNAVAILABLE: 4404,
  QUOTA_EXHAUSTED: 4407,
  RATE_LIMITED: 4408,
  DUPLICATE_PEER: 4409,
  BACKPRESSURE: 4410,
  BUDGET_EXHAUSTED: 4411,
  KILL_SWITCH: 4412,
  LEASE_EXPIRED: 4413,
  MESSAGE_TOO_LARGE: 4414,
  BINARY_ONLY: 4415,
  SESSION_EXPIRED: 4416,
  INTERNAL_ERROR: 4500,
} as const;

export const DEFAULTS = {
  WEEKLY_VIEWER_SECONDS: 2 * 60 * 60,
  LEASE_SECONDS: 15 * 60,
  LEASE_RESERVATION_MICRO_USD: 2_500,
  BUDGET_CEILING_MICRO_USD: 900_000_000,
  BILLING_PERIOD_START_DAY_UTC: 1,
  SESSION_TTL_SECONDS: 24 * 60 * 60,
  MAX_MESSAGE_BYTES: 2 * 1024 * 1024,
  SUSTAINED_MESSAGES_PER_SECOND: 15,
  BURST_MESSAGES: 20,
  MAX_BITS_PER_SECOND: 10_000_000,
  MAX_BUFFERED_BYTES: 4 * 1024 * 1024,
} as const;

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};
