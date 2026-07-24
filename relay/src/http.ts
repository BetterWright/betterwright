import { SECURITY_HEADERS } from "./constants";

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  const combined = new Headers(SECURITY_HEADERS);
  combined.set("Content-Type", "application/json; charset=utf-8");
  if (headers) new Headers(headers).forEach((entry, key) => combined.set(key, entry));
  return Response.json(value, { status, headers: combined });
}

export function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } satisfies ApiErrorBody["error"] }, status);
}

export function emptyResponse(status = 204, headers?: HeadersInit): Response {
  const combined = new Headers(SECURITY_HEADERS);
  if (headers) new Headers(headers).forEach((entry, key) => combined.set(key, entry));
  return new Response(null, { status, headers: combined });
}

export async function readJsonObject(request: Request, maximumBytes = 16_384): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("Content-Type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpError(415, "unsupported_media_type", "Use application/json");
  const declaredLength = Number(request.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    throw new HttpError(413, "body_too_large", "Request body is too large");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    throw new HttpError(413, "body_too_large", "Request body is too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new HttpError(400, "invalid_body", "Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function normalizeThrownError(error: unknown): Response {
  if (error instanceof HttpError) return errorResponse(error.status, error.code, error.message);
  return errorResponse(500, "internal_error", "The relay could not complete the request");
}

export function enforceExactApiOrigin(request: Request, appOrigin: string): void {
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== appOrigin) {
    throw new HttpError(403, "origin_denied", "Request origin is not allowed");
  }
}

export function applyCors(response: Response, request: Request, appOrigin: string): Response {
  if (request.headers.get("Origin") !== appOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", appOrigin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.append("Vary", "Origin");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function preflightResponse(request: Request, appOrigin: string): Response {
  enforceExactApiOrigin(request, appOrigin);
  if (request.headers.get("Origin") !== appOrigin) {
    throw new HttpError(403, "origin_required", "An exact browser origin is required");
  }
  const requestedMethod = request.headers.get("Access-Control-Request-Method")?.toUpperCase();
  if (!requestedMethod || !["GET", "POST", "DELETE", "PUT"].includes(requestedMethod)) {
    throw new HttpError(405, "method_not_allowed", "Requested method is not allowed");
  }
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("Access-Control-Allow-Origin", appOrigin);
  headers.set("Access-Control-Allow-Credentials", "true");
  headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, PUT, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Max-Age", "600");
  headers.set("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
  return new Response(null, { status: 204, headers });
}

export function bearerCredential(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header || header.length > 8_192) return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  return match?.[1] ?? null;
}

export function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie || cookie.length > 16_384) return null;
  for (const entry of cookie.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() === name) {
      return entry.slice(separator + 1).trim() || null;
    }
  }
  return null;
}
