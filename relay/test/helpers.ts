import type { Env } from "../src/env";

export class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put<T>(keyOrEntries: string | Record<string, unknown>, value?: T): Promise<void> {
    if (typeof keyOrEntries === "string") this.values.set(keyOrEntries, value);
    else for (const [key, entry] of Object.entries(keyOrEntries)) this.values.set(key, entry);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }

  async deleteAll(): Promise<void> {
    this.values.clear();
    this.alarm = null;
  }

  async setAlarm(time: number | Date): Promise<void> {
    this.alarm = time instanceof Date ? time.getTime() : time;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

export class MemoryDurableState {
  readonly storageImpl = new MemoryStorage();
  readonly sockets = new Map<string, WebSocket[]>();
  readonly storage = this.storageImpl as unknown as DurableObjectStorage;

  getWebSockets(tag?: string): WebSocket[] {
    if (tag) return this.sockets.get(tag) ?? [];
    return [...this.sockets.values()].flat();
  }

  acceptWebSocket(webSocket: WebSocket, tags?: string[]): void {
    for (const tag of tags ?? []) {
      const sockets = this.sockets.get(tag) ?? [];
      sockets.push(webSocket);
      this.sockets.set(tag, sockets);
    }
  }

  asState(): DurableObjectState {
    return this as unknown as DurableObjectState;
  }
}

interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_hash: string;
  created_at_ms: number;
  last_used_at_ms: number | null;
  revoked_at_ms: number | null;
}

interface SessionRow {
  id: string;
  user_id: string;
  api_key_id: string;
  host_cap_hash: string;
  viewer_cap_hash: string;
  created_at_ms: number;
  expires_at_ms: number;
  ended_at_ms: number | null;
  ended_reason: string | null;
}

export class FakeD1 {
  readonly apiKeys: ApiKeyRow[] = [];
  readonly sessions: SessionRow[] = [];
  sessionDeleteFailures = 0;
  control = { kill_switch_enabled: 0, reason: "", updated_at_ms: 0 };

  prepare(sql: string): D1PreparedStatement {
    return new FakeStatement(this, sql) as unknown as D1PreparedStatement;
  }

  asDatabase(): D1Database {
    return this as unknown as D1Database;
  }
}

class FakeStatement {
  private parameters: unknown[] = [];
  private readonly normalized: string;

  constructor(
    private readonly db: FakeD1,
    sql: string,
  ) {
    this.normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
  }

  bind(...parameters: unknown[]): this {
    this.parameters = parameters;
    return this;
  }

  async run(): Promise<D1Result> {
    const sql = this.normalized;
    let changes = 0;
    if (sql.startsWith("insert into api_keys")) {
      const [id, userId, name, keyHash, createdAt] = this.parameters as [string, string, string, string, number];
      if (this.db.apiKeys.filter((row) => row.user_id === userId && row.revoked_at_ms === null).length >= 5) {
        throw new Error("SQLITE_CONSTRAINT: active_api_key_limit");
      }
      this.db.apiKeys.push({
        id,
        user_id: userId,
        name,
        key_hash: keyHash,
        created_at_ms: createdAt,
        last_used_at_ms: null,
        revoked_at_ms: null,
      });
      changes = 1;
    } else if (sql.startsWith("update api_keys set revoked_at_ms")) {
      const [now, id, userId] = this.parameters as [number, string, string];
      const row = this.db.apiKeys.find(
        (entry) => entry.id === id && entry.user_id === userId && entry.revoked_at_ms === null,
      );
      if (row) {
        row.revoked_at_ms = now;
        changes = 1;
      }
    } else if (sql.startsWith("update api_keys set last_used_at_ms")) {
      const [now, id] = this.parameters as [number, string];
      const row = this.db.apiKeys.find((entry) => entry.id === id && entry.revoked_at_ms === null);
      if (row) {
        row.last_used_at_ms = now;
        changes = 1;
      }
    } else if (sql.startsWith("insert into sessions")) {
      const [id, userId, apiKeyId, hostHash, viewerHash, createdAt, expiresAt] = this.parameters as [
        string,
        string,
        string,
        string,
        string,
        number,
        number,
      ];
      if (this.db.sessions.some((row) => row.id === id)) {
        throw new Error("SQLITE_CONSTRAINT: UNIQUE constraint failed: sessions.id");
      }
      this.db.sessions.push({
        id,
        user_id: userId,
        api_key_id: apiKeyId,
        host_cap_hash: hostHash,
        viewer_cap_hash: viewerHash,
        created_at_ms: createdAt,
        expires_at_ms: expiresAt,
        ended_at_ms: null,
        ended_reason: null,
      });
      changes = 1;
    } else if (sql.startsWith("update sessions set ended_at_ms")) {
      const [now, reason, id, userId] = this.parameters as [number, string, string, string];
      const row = this.db.sessions.find((entry) => entry.id === id && entry.user_id === userId);
      if (row) {
        row.ended_at_ms ??= now;
        row.ended_reason ??= reason;
        changes = 1;
      }
    } else if (sql.startsWith("delete from sessions where id = ?1 and user_id = ?2")) {
      if (this.db.sessionDeleteFailures > 0) {
        this.db.sessionDeleteFailures -= 1;
        throw new Error("transient D1 session delete failure");
      }
      const [id, userId] = this.parameters as [string, string];
      const index = this.db.sessions.findIndex(
        (entry) => entry.id === id && entry.user_id === userId,
      );
      if (index !== -1) {
        this.db.sessions.splice(index, 1);
        changes = 1;
      }
    } else if (sql.startsWith("update relay_control")) {
      const [enabled, reason, now] = this.parameters as [number, string, number];
      this.db.control = { kill_switch_enabled: enabled, reason, updated_at_ms: now };
      changes = 1;
    } else {
      throw new Error(`Unsupported fake D1 run: ${this.normalized}`);
    }
    return { success: true, meta: { changes } } as unknown as D1Result;
  }

  async first<T>(): Promise<T | null> {
    const sql = this.normalized;
    if (sql.includes("from relay_control")) return { ...this.db.control } as T;
    if (sql.includes("from api_keys where id = ?1")) {
      const row = this.db.apiKeys.find((entry) => entry.id === this.parameters[0]);
      return (row ? { ...row } : null) as T | null;
    }
    if (sql.includes("from sessions where id = ?1 and user_id = ?2")) {
      const row = this.db.sessions.find(
        (entry) => entry.id === this.parameters[0] && entry.user_id === this.parameters[1],
      );
      return (row ? { ...row } : null) as T | null;
    }
    if (sql.includes("from sessions where id = ?1")) {
      const row = this.db.sessions.find((entry) => entry.id === this.parameters[0]);
      return (row ? { ...row } : null) as T | null;
    }
    if (sql.includes("select count(*) as count from sessions")) {
      const [userId, now] = this.parameters as [string, number];
      return {
        count: this.db.sessions.filter(
          (entry) => entry.user_id === userId && entry.ended_at_ms === null && entry.expires_at_ms > now,
        ).length,
      } as T;
    }
    throw new Error(`Unsupported fake D1 first: ${this.normalized}`);
  }

  async all<T>(): Promise<D1Result<T>> {
    const sql = this.normalized;
    let results: unknown[];
    if (sql.includes("from api_keys") && sql.includes("where user_id = ?1")) {
      results = this.db.apiKeys
        .filter((row) => row.user_id === this.parameters[0] && row.revoked_at_ms === null)
        .sort((left, right) => right.created_at_ms - left.created_at_ms)
        .map((row) => ({ ...row }));
    } else if (sql.includes("select id from sessions")) {
      const [now, limit] = this.parameters as [number, number];
      results = this.db.sessions
        .filter((row) => row.ended_at_ms === null && row.expires_at_ms > now)
        .sort((left, right) => left.created_at_ms - right.created_at_ms)
        .slice(0, limit)
        .map((row) => ({ id: row.id }));
    } else {
      throw new Error(`Unsupported fake D1 all: ${this.normalized}`);
    }
    return { success: true, results } as unknown as D1Result<T>;
  }
}

export function makeBaseEnv(overrides: Partial<Env> = {}): Env {
  const d1 = new FakeD1();
  const unavailableNamespace = {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async () => new Response("not configured", { status: 503 }) }),
  } as unknown as DurableObjectNamespace;
  return {
    DB: d1.asDatabase(),
    RELAY_SESSION: unavailableNamespace,
    USER_QUOTA: unavailableNamespace,
    BUDGET_WINDOW: unavailableNamespace,
    ASSETS: { fetch: async () => new Response("asset", { status: 404 }) } as unknown as Fetcher,
    PUBLIC_ORIGIN: "https://relay.example.com",
    APP_ORIGIN: "https://app.example.com",
    CLERK_AUTHORIZED_PARTIES: "https://app.example.com",
    CLERK_JWT_KEY: "test-public-key",
    CLERK_WEBHOOK_SIGNING_SECRET: "whsec_test-secret-with-at-least-32-chars",
    API_KEY_HMAC_SECRET: "api-hmac-secret-with-at-least-32-chars",
    CAPABILITY_HMAC_SECRET: "cap-hmac-secret-with-at-least-32-chars",
    INTERNAL_DO_SECRET: "internal-secret-with-at-least-32-chars",
    ADMIN_TOKEN: "admin-token-with-at-least-32-characters",
    ...overrides,
  };
}

export class DirectNamespace {
  readonly instances = new Map<string, { fetch(request: Request): Promise<Response> }>();

  constructor(private readonly factory: (name: string) => { fetch(request: Request): Promise<Response> }) {}

  idFromName(name: string): DurableObjectId {
    return name as unknown as DurableObjectId;
  }

  get(id: DurableObjectId): DurableObjectStub {
    const name = String(id);
    let instance = this.instances.get(name);
    if (!instance) {
      instance = this.factory(name);
      this.instances.set(name, instance);
    }
    return instance as unknown as DurableObjectStub;
  }

  asNamespace(): DurableObjectNamespace {
    return this as unknown as DurableObjectNamespace;
  }
}

export function jsonRequest(path: string, body: unknown, headers: HeadersInit = {}): Request {
  return new Request(`https://internal${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...Object.fromEntries(new Headers(headers)) },
    body: JSON.stringify(body),
  });
}
