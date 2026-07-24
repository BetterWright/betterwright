import { authenticateInternalRequest } from "../auth";
import type { Env } from "../env";
import { HttpError, jsonResponse, normalizeThrownError, readJsonObject } from "../http";
import { SerialGate } from "../serial";

interface WindowMeta {
  key: string;
  startsAtMs: number;
  endsAtMs: number;
}

function integerField(body: Record<string, unknown>, name: string, minimum = 0): number {
  const value = body[name];
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new HttpError(400, "invalid_internal_request", `${name} must be an integer`);
  }
  return value as number;
}

export class BudgetWindow implements DurableObject {
  private readonly gate = new SerialGate();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    try {
      await authenticateInternalRequest(request, this.env);
      const path = new URL(request.url).pathname;
      if (path === "/reserve" && request.method === "POST") {
        return await this.gate.run(() => this.reserve(request));
      }
      if (path === "/status" && request.method === "GET") {
        return await this.gate.run(() => this.status());
      }
      throw new HttpError(404, "not_found", "Internal endpoint not found");
    } catch (error) {
      return normalizeThrownError(error);
    }
  }

  private async reserve(request: Request): Promise<Response> {
    const body = await readJsonObject(request, 4_096);
    const reservationId = typeof body.reservationId === "string" ? body.reservationId : "";
    const key = typeof body.windowKey === "string" ? body.windowKey : "";
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(reservationId) || !/^[A-Za-z0-9._:-]{1,80}$/.test(key)) {
      throw new HttpError(400, "invalid_internal_request", "Invalid reservation or window identifier");
    }
    const amountMicroUsd = integerField(body, "amountMicroUsd", 1);
    const ceilingMicroUsd = integerField(body, "ceilingMicroUsd", 1);
    const startsAtMs = integerField(body, "startsAtMs", 0);
    const endsAtMs = integerField(body, "endsAtMs", startsAtMs + 1);
    const reservationStorageKey = `reservation:${reservationId}`;

    const existing = await this.state.storage.get<number>(reservationStorageKey);
    const currentTotal = (await this.state.storage.get<number>("totalMicroUsd")) ?? 0;
    if (existing !== undefined) {
      return jsonResponse({ ok: true, idempotent: true, reservedMicroUsd: currentTotal });
    }

    const meta = await this.state.storage.get<WindowMeta>("window");
    if (meta && (meta.key !== key || meta.startsAtMs !== startsAtMs || meta.endsAtMs !== endsAtMs)) {
      throw new HttpError(409, "window_mismatch", "Budget window identity does not match this object");
    }
    if (currentTotal + amountMicroUsd > ceilingMicroUsd) {
      return jsonResponse(
        {
          ok: false,
          code: "budget_exhausted",
          reservedMicroUsd: currentTotal,
          ceilingMicroUsd,
        },
        409,
      );
    }

    const nextTotal = currentTotal + amountMicroUsd;
    const writes: Record<string, unknown> = {
      [reservationStorageKey]: amountMicroUsd,
      totalMicroUsd: nextTotal,
    };
    if (!meta) writes.window = { key, startsAtMs, endsAtMs } satisfies WindowMeta;
    await this.state.storage.put(writes);
    return jsonResponse({ ok: true, idempotent: false, reservedMicroUsd: nextTotal });
  }

  private async status(): Promise<Response> {
    const [window, totalMicroUsd] = await Promise.all([
      this.state.storage.get<WindowMeta>("window"),
      this.state.storage.get<number>("totalMicroUsd"),
    ]);
    return jsonResponse({ ok: true, window: window ?? null, reservedMicroUsd: totalMicroUsd ?? 0 });
  }
}
