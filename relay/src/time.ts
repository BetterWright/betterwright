const DAY_MS = 24 * 60 * 60 * 1_000;
const WEEK_MS = 7 * DAY_MS;

export interface TimeWindow {
  key: string;
  startsAtMs: number;
  endsAtMs: number;
}

function dateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** ISO week in UTC: Monday 00:00:00 through the next Monday. */
export function isoWeekWindow(nowMs: number): TimeWindow {
  const now = new Date(nowMs);
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  const startsAtMs = midnight - daysSinceMonday * DAY_MS;
  return {
    key: dateKey(startsAtMs),
    startsAtMs,
    endsAtMs: startsAtMs + WEEK_MS,
  };
}

/**
 * Monthly UTC billing window anchored to a day in [1, 28]. An explicit key is
 * useful when the Cloudflare account has a non-calendar contractual period.
 */
export function billingWindow(
  nowMs: number,
  startDayUtc: number,
  explicitKey?: string,
): TimeWindow {
  const now = new Date(nowMs);
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  if (now.getUTCDate() < startDayUtc) {
    month -= 1;
    if (month < 0) {
      year -= 1;
      month = 11;
    }
  }
  const startsAtMs = Date.UTC(year, month, startDayUtc);
  const endsAtMs = Date.UTC(year, month + 1, startDayUtc);
  return {
    key: explicitKey || dateKey(startsAtMs),
    startsAtMs,
    endsAtMs,
  };
}

export function toIso(ms: number | null | undefined): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
