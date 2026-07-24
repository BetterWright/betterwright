import { requireSecret } from "../config";
import { constantTimeEqual, generateApiKey, hashApiKey, parseApiKey } from "../crypto";
import type { Env, ExecutionContextLike } from "../env";
import { bearerCredential, HttpError } from "../http";
import { toIso } from "../time";

interface ApiKeyRow {
  id: string;
  user_id: string;
  name: string;
  key_hash: string;
  created_at_ms: number;
  last_used_at_ms: number | null;
  revoked_at_ms: number | null;
}

export interface ApiKeyPrincipal {
  userId: string;
  apiKeyId: string;
}

export interface PublicApiKey {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

function publicKey(row: Pick<ApiKeyRow, "id" | "name" | "created_at_ms" | "last_used_at_ms">): PublicApiKey {
  return {
    id: row.id,
    name: row.name,
    prefix: `bw_live_${row.id}_…`,
    createdAt: new Date(row.created_at_ms).toISOString(),
    lastUsedAt: toIso(row.last_used_at_ms),
  };
}

export function validateApiKeyName(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "invalid_name", "Key name must be a string");
  const name = value.trim();
  if (name.length < 1 || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw new HttpError(400, "invalid_name", "Key name must contain 1 to 80 printable characters");
  }
  return name;
}

export async function listApiKeys(db: D1Database, userId: string): Promise<PublicApiKey[]> {
  const result = await db
    .prepare(
      `SELECT id, name, created_at_ms, last_used_at_ms
       FROM api_keys
       WHERE user_id = ?1 AND revoked_at_ms IS NULL
       ORDER BY created_at_ms DESC`,
    )
    .bind(userId)
    .all<Pick<ApiKeyRow, "id" | "name" | "created_at_ms" | "last_used_at_ms">>();
  return (result.results ?? []).map(publicKey);
}

export async function createApiKey(
  env: Env,
  userId: string,
  nameValue: unknown,
  nowMs = Date.now(),
): Promise<{ key: PublicApiKey; secret: string }> {
  const name = validateApiKeyName(nameValue);
  const generated = generateApiKey();
  const keyHash = await hashApiKey(requireSecret(env, "API_KEY_HMAC_SECRET"), generated.value);
  try {
    await env.DB
      .prepare(
        `INSERT INTO api_keys (id, user_id, name, key_hash, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(generated.id, userId, name, keyHash, nowMs)
      .run();
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("active_api_key_limit")) {
      throw new HttpError(409, "key_limit_reached", "An account can have at most five active API keys");
    }
    throw error;
  }
  return {
    key: publicKey({ id: generated.id, name, created_at_ms: nowMs, last_used_at_ms: null }),
    secret: generated.value,
  };
}

export async function revokeApiKey(
  db: D1Database,
  userId: string,
  keyId: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{16}$/.test(keyId)) return false;
  const result = await db
    .prepare(
      `UPDATE api_keys
       SET revoked_at_ms = ?1
       WHERE id = ?2 AND user_id = ?3 AND revoked_at_ms IS NULL`,
    )
    .bind(nowMs, keyId, userId)
    .run();
  return Number(result.meta.changes ?? 0) === 1;
}

export async function authenticateApiKeyRequest(
  request: Request,
  env: Env,
  context?: ExecutionContextLike,
): Promise<ApiKeyPrincipal> {
  const candidate = bearerCredential(request);
  const parsed = candidate ? parseApiKey(candidate) : null;
  if (!candidate || !parsed) {
    throw new HttpError(401, "invalid_api_key", "A valid BetterWright API key is required");
  }
  const row = await env.DB
    .prepare(
      `SELECT id, user_id, key_hash, revoked_at_ms
       FROM api_keys WHERE id = ?1`,
    )
    .bind(parsed.id)
    .first<Pick<ApiKeyRow, "id" | "user_id" | "key_hash" | "revoked_at_ms">>();
  if (!row || row.revoked_at_ms !== null) {
    throw new HttpError(401, "invalid_api_key", "A valid BetterWright API key is required");
  }
  const candidateHash = await hashApiKey(requireSecret(env, "API_KEY_HMAC_SECRET"), candidate);
  if (!constantTimeEqual(candidateHash, row.key_hash)) {
    throw new HttpError(401, "invalid_api_key", "A valid BetterWright API key is required");
  }
  const update = env.DB
    .prepare("UPDATE api_keys SET last_used_at_ms = ?1 WHERE id = ?2 AND revoked_at_ms IS NULL")
    .bind(Date.now(), row.id)
    .run()
    .catch(() => undefined);
  if (context) context.waitUntil(update);
  else await update;
  return { userId: row.user_id, apiKeyId: row.id };
}
