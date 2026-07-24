import { DEFAULTS } from "./constants";
import type { Env } from "./env";

export interface RelayConfig {
  publicOrigin: string;
  appOrigin: string;
  clerkAuthorizedParties: string[];
  clerkAudience?: string;
  weeklyViewerMs: number;
  leaseMs: number;
  leaseReservationMicroUsd: number;
  budgetCeilingMicroUsd: number;
  billingPeriodStartDayUtc: number;
  billingWindowId?: string;
  sessionTtlMs: number;
  maxMessageBytes: number;
  sustainedMessagesPerSecond: number;
  burstMessages: number;
  maxBytesPerSecond: number;
  maxBufferedBytes: number;
  envKillSwitch: boolean;
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  min: number,
  max: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  if (!/^\d+$/.test(value.trim())) throw new ConfigurationError(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigurationError(`${name} is outside the supported range`);
  }
  return parsed;
}

export function usdToMicroUsd(value: string, name: string): number {
  const trimmed = value.trim();
  const match = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(trimmed);
  if (!match) throw new ConfigurationError(`${name} must be a non-negative USD decimal`);
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0"));
  const result = whole * 1_000_000n + fraction;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ConfigurationError(`${name} is too large`);
  }
  return Number(result);
}

function exactOrigin(value: string | undefined, name: string): string {
  if (!value) throw new ConfigurationError(`${name} is required`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigurationError(`${name} must be an absolute origin`);
  }
  const localHttp = parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !localHttp) {
    throw new ConfigurationError(`${name} must use HTTPS outside local development`);
  }
  if (
    value.includes("*") ||
    parsed.hostname.includes("*") ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ConfigurationError(`${name} must contain only scheme, host, and optional port`);
  }
  if (value.replace(/\/$/, "") !== parsed.origin) {
    throw new ConfigurationError(`${name} must be a canonical exact origin`);
  }
  return parsed.origin;
}

function parseAuthorizedParties(value: string | undefined): string[] {
  if (!value) throw new ConfigurationError("CLERK_AUTHORIZED_PARTIES is required");
  const parties = value
    .split(",")
    .map((entry) => exactOrigin(entry.trim(), "CLERK_AUTHORIZED_PARTIES entry"));
  if (parties.length === 0 || parties.some((entry) => !entry)) {
    throw new ConfigurationError("CLERK_AUTHORIZED_PARTIES must not be empty");
  }
  return [...new Set(parties)];
}

function booleanValue(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function getConfig(env: Env): RelayConfig {
  // Fail closed before reporting readiness or admitting any request. A Worker
  // deployment without its cryptographic/authentication secrets must never
  // appear healthy.
  requireSecret(env, "API_KEY_HMAC_SECRET");
  requireSecret(env, "CAPABILITY_HMAC_SECRET");
  requireSecret(env, "INTERNAL_DO_SECRET");
  requireSecret(env, "ADMIN_TOKEN");
  requireSecret(env, "CLERK_WEBHOOK_SIGNING_SECRET");
  if (!env.CLERK_JWT_KEY?.trim() && !env.CLERK_SECRET_KEY?.trim()) {
    throw new ConfigurationError("Clerk token verification is not configured");
  }

  const weeklyViewerSeconds = positiveInteger(
    env.WEEKLY_VIEWER_SECONDS,
    DEFAULTS.WEEKLY_VIEWER_SECONDS,
    "WEEKLY_VIEWER_SECONDS",
    60,
    7 * 24 * 60 * 60,
  );
  const leaseSeconds = positiveInteger(
    env.LEASE_SECONDS,
    DEFAULTS.LEASE_SECONDS,
    "LEASE_SECONDS",
    60,
    60 * 60,
  );
  const sessionTtlSeconds = positiveInteger(
    env.SESSION_TTL_SECONDS,
    DEFAULTS.SESSION_TTL_SECONDS,
    "SESSION_TTL_SECONDS",
    leaseSeconds,
    7 * 24 * 60 * 60,
  );
  const maxBitsPerSecond = positiveInteger(
    env.MAX_BITS_PER_SECOND,
    DEFAULTS.MAX_BITS_PER_SECOND,
    "MAX_BITS_PER_SECOND",
    8_000,
    1_000_000_000,
  );
  const billingWindowId = env.BILLING_WINDOW_ID?.trim();
  if (billingWindowId && !/^[A-Za-z0-9._:-]{1,80}$/.test(billingWindowId)) {
    throw new ConfigurationError("BILLING_WINDOW_ID contains unsupported characters");
  }

  return {
    publicOrigin: exactOrigin(env.PUBLIC_ORIGIN, "PUBLIC_ORIGIN"),
    appOrigin: exactOrigin(env.APP_ORIGIN, "APP_ORIGIN"),
    clerkAuthorizedParties: parseAuthorizedParties(env.CLERK_AUTHORIZED_PARTIES),
    clerkAudience: env.CLERK_AUDIENCE?.trim() || undefined,
    weeklyViewerMs: weeklyViewerSeconds * 1_000,
    leaseMs: leaseSeconds * 1_000,
    leaseReservationMicroUsd: env.LEASE_RESERVATION_USD
      ? usdToMicroUsd(env.LEASE_RESERVATION_USD, "LEASE_RESERVATION_USD")
      : DEFAULTS.LEASE_RESERVATION_MICRO_USD,
    budgetCeilingMicroUsd: env.BUDGET_CEILING_USD
      ? usdToMicroUsd(env.BUDGET_CEILING_USD, "BUDGET_CEILING_USD")
      : DEFAULTS.BUDGET_CEILING_MICRO_USD,
    billingPeriodStartDayUtc: positiveInteger(
      env.BILLING_PERIOD_START_DAY_UTC,
      DEFAULTS.BILLING_PERIOD_START_DAY_UTC,
      "BILLING_PERIOD_START_DAY_UTC",
      1,
      28,
    ),
    billingWindowId: billingWindowId || undefined,
    sessionTtlMs: sessionTtlSeconds * 1_000,
    maxMessageBytes: positiveInteger(
      env.MAX_MESSAGE_BYTES,
      DEFAULTS.MAX_MESSAGE_BYTES,
      "MAX_MESSAGE_BYTES",
      1_024,
      32 * 1024 * 1024,
    ),
    sustainedMessagesPerSecond: positiveInteger(
      env.SUSTAINED_MESSAGES_PER_SECOND,
      DEFAULTS.SUSTAINED_MESSAGES_PER_SECOND,
      "SUSTAINED_MESSAGES_PER_SECOND",
      1,
      1_000,
    ),
    burstMessages: positiveInteger(
      env.BURST_MESSAGES,
      DEFAULTS.BURST_MESSAGES,
      "BURST_MESSAGES",
      1,
      10_000,
    ),
    maxBytesPerSecond: Math.floor(maxBitsPerSecond / 8),
    maxBufferedBytes: positiveInteger(
      env.MAX_BUFFERED_BYTES,
      DEFAULTS.MAX_BUFFERED_BYTES,
      "MAX_BUFFERED_BYTES",
      64 * 1024,
      64 * 1024 * 1024,
    ),
    envKillSwitch: booleanValue(env.RELAY_KILL_SWITCH),
  };
}

export function requireSecret(env: Env, name: keyof Env, minimumLength = 32): string {
  const value = env[name];
  if (typeof value !== "string" || value.length < minimumLength) {
    throw new ConfigurationError(`${String(name)} must be a secret of at least ${minimumLength} characters`);
  }
  return value;
}
