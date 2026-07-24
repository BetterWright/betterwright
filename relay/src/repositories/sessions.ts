import { isSessionId } from "../crypto";
import type { Env } from "../env";
import { toIso } from "../time";

export interface SessionRow {
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

export interface PublicSession {
  id: string;
  createdAt: string;
  expiresAt: string;
  endedAt: string | null;
  status: "waiting" | "active" | "ended" | "expired";
}

export function publicSession(row: SessionRow, nowMs = Date.now()): PublicSession {
  const ended = row.ended_at_ms !== null;
  const expired = !ended && row.expires_at_ms <= nowMs;
  return {
    id: row.id,
    createdAt: new Date(row.created_at_ms).toISOString(),
    expiresAt: new Date(row.expires_at_ms).toISOString(),
    endedAt: toIso(row.ended_at_ms),
    status: ended ? "ended" : expired ? "expired" : "waiting",
  };
}

export async function insertSession(env: Env, row: SessionRow): Promise<void> {
  await env.DB
    .prepare(
      `INSERT INTO sessions (
         id, user_id, api_key_id, host_cap_hash, viewer_cap_hash,
         created_at_ms, expires_at_ms, ended_at_ms, ended_reason
       ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL)`,
    )
    .bind(
      row.id,
      row.user_id,
      row.api_key_id,
      row.host_cap_hash,
      row.viewer_cap_hash,
      row.created_at_ms,
      row.expires_at_ms,
    )
    .run();
}

export async function findSessionForOwner(
  db: D1Database,
  sessionId: string,
  userId: string,
): Promise<SessionRow | null> {
  if (!isSessionId(sessionId)) return null;
  return db
    .prepare(
      `SELECT id, user_id, api_key_id, host_cap_hash, viewer_cap_hash,
              created_at_ms, expires_at_ms, ended_at_ms, ended_reason
       FROM sessions WHERE id = ?1 AND user_id = ?2`,
    )
    .bind(sessionId, userId)
    .first<SessionRow>();
}

export async function findSessionForAdmission(
  db: D1Database,
  sessionId: string,
): Promise<Pick<SessionRow, "id" | "user_id" | "expires_at_ms" | "ended_at_ms"> | null> {
  if (!isSessionId(sessionId)) return null;
  return db
    .prepare(
      `SELECT id, user_id, expires_at_ms, ended_at_ms
       FROM sessions WHERE id = ?1`,
    )
    .bind(sessionId)
    .first<Pick<SessionRow, "id" | "user_id" | "expires_at_ms" | "ended_at_ms">>();
}

export async function endSession(
  db: D1Database,
  sessionId: string,
  userId: string,
  reason: string,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!isSessionId(sessionId)) return false;
  const result = await db
    .prepare(
      `UPDATE sessions
       SET ended_at_ms = COALESCE(ended_at_ms, ?1),
           ended_reason = COALESCE(ended_reason, ?2)
       WHERE id = ?3 AND user_id = ?4`,
    )
    .bind(nowMs, reason.slice(0, 80), sessionId, userId)
    .run();
  return Number(result.meta.changes ?? 0) === 1;
}

export async function countActiveSessions(db: D1Database, userId: string, nowMs = Date.now()): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sessions
       WHERE user_id = ?1 AND ended_at_ms IS NULL AND expires_at_ms > ?2`,
    )
    .bind(userId, nowMs)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
}

export async function listActiveSessionIds(
  db: D1Database,
  nowMs = Date.now(),
  limit = 10_000,
): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT id FROM sessions
       WHERE ended_at_ms IS NULL AND expires_at_ms > ?1
       ORDER BY created_at_ms ASC LIMIT ?2`,
    )
    .bind(nowMs, limit)
    .all<{ id: string }>();
  return (result.results ?? []).map((row) => row.id);
}


export async function listSessionIdsForUser(
  db: D1Database,
  userId: string,
): Promise<string[]> {
  const result = await db
    .prepare("SELECT id FROM sessions WHERE user_id = ?1")
    .bind(userId)
    .all<{ id: string }>();
  return (result.results ?? []).map((row) => row.id);
}
