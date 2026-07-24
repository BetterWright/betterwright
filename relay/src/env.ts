export interface Env {
  DB: D1Database;
  RELAY_SESSION: DurableObjectNamespace;
  USER_QUOTA: DurableObjectNamespace;
  BUDGET_WINDOW: DurableObjectNamespace;
  ASSETS: Fetcher;

  PUBLIC_ORIGIN: string;
  APP_ORIGIN: string;
  CLERK_AUTHORIZED_PARTIES: string;
  CLERK_AUDIENCE?: string;
  CLERK_JWT_KEY?: string;
  CLERK_SECRET_KEY?: string;
  CLERK_WEBHOOK_SIGNING_SECRET?: string;

  API_KEY_HMAC_SECRET: string;
  CAPABILITY_HMAC_SECRET: string;
  INTERNAL_DO_SECRET: string;
  ADMIN_TOKEN: string;

  WEEKLY_VIEWER_SECONDS?: string;
  LEASE_SECONDS?: string;
  LEASE_RESERVATION_USD?: string;
  BUDGET_CEILING_USD?: string;
  BILLING_PERIOD_START_DAY_UTC?: string;
  BILLING_WINDOW_ID?: string;
  SESSION_TTL_SECONDS?: string;
  MAX_MESSAGE_BYTES?: string;
  SUSTAINED_MESSAGES_PER_SECOND?: string;
  BURST_MESSAGES?: string;
  MAX_BITS_PER_SECOND?: string;
  MAX_BUFFERED_BYTES?: string;
  RELAY_KILL_SWITCH?: string;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}
