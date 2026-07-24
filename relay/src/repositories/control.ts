import type { RelayConfig } from "../config";
import type { Env } from "../env";
import { HttpError } from "../http";
import { toIso } from "../time";

interface ControlRow {
  kill_switch_enabled: number;
  reason: string;
  updated_at_ms: number;
}

export interface KillSwitchState {
  persistentEnabled: boolean;
  environmentEnabled: boolean;
  effectiveEnabled: boolean;
  reason: string;
  updatedAt: string | null;
}

export async function getKillSwitch(env: Env, config: RelayConfig): Promise<KillSwitchState> {
  const row = await env.DB
    .prepare(
      `SELECT kill_switch_enabled, reason, updated_at_ms
       FROM relay_control WHERE singleton = 1`,
    )
    .first<ControlRow>();
  if (!row) throw new Error("relay control row is missing");
  const persistentEnabled = row.kill_switch_enabled === 1;
  return {
    persistentEnabled,
    environmentEnabled: config.envKillSwitch,
    effectiveEnabled: persistentEnabled || config.envKillSwitch,
    reason: row.reason,
    updatedAt: row.updated_at_ms > 0 ? toIso(row.updated_at_ms) : null,
  };
}

export async function setPersistentKillSwitch(
  env: Env,
  enabledValue: unknown,
  reasonValue: unknown,
  nowMs = Date.now(),
): Promise<void> {
  if (typeof enabledValue !== "boolean") {
    throw new HttpError(400, "invalid_enabled", "enabled must be a boolean");
  }
  const reason = reasonValue === undefined ? "" : String(reasonValue).trim();
  if (reason.length > 200 || /[\u0000-\u001f\u007f]/.test(reason)) {
    throw new HttpError(400, "invalid_reason", "reason must contain at most 200 printable characters");
  }
  await env.DB
    .prepare(
      `UPDATE relay_control
       SET kill_switch_enabled = ?1, reason = ?2, updated_at_ms = ?3
       WHERE singleton = 1`,
    )
    .bind(enabledValue ? 1 : 0, reason, nowMs)
    .run();
}
