import { verifyToken } from "@clerk/backend";
import type { RelayConfig } from "./config";
import { requireSecret } from "./config";
import { secureTokenEqual } from "./crypto";
import type { Env } from "./env";
import { bearerCredential, cookieValue, HttpError } from "./http";

export interface ClerkPrincipal {
  userId: string;
  sessionId?: string;
}

export async function authenticateClerkRequest(
  request: Request,
  env: Env,
  config: RelayConfig,
): Promise<ClerkPrincipal> {
  const bearer = bearerCredential(request);
  const cookie = bearer ? null : cookieValue(request, "__session");
  const token = bearer ?? cookie;
  if (!token || token.length > 8_192) {
    throw new HttpError(401, "authentication_required", "A valid Clerk session token is required");
  }
  if (cookie && !["GET", "HEAD", "OPTIONS"].includes(request.method) && request.headers.get("Origin") !== config.appOrigin) {
    throw new HttpError(403, "origin_required", "Cookie-authenticated mutations require the exact app origin");
  }

  const jwtKey = env.CLERK_JWT_KEY?.replace(/\\n/g, "\n").trim();
  const secretKey = env.CLERK_SECRET_KEY?.trim();
  if (!jwtKey && !secretKey) {
    throw new HttpError(500, "auth_not_configured", "Clerk token verification is not configured");
  }

  try {
    const verified = await verifyToken(token, {
      ...(jwtKey ? { jwtKey } : { secretKey }),
      authorizedParties: config.clerkAuthorizedParties,
      ...(config.clerkAudience ? { audience: config.clerkAudience } : {}),
      clockSkewInMs: 5_000,
    });
    return clerkPrincipalFromVerification(verified);
  } catch {
    throw new HttpError(401, "invalid_session", "The Clerk session token is invalid or expired");
  }
}

export async function authenticateAdminRequest(request: Request, env: Env): Promise<void> {
  const candidate = bearerCredential(request);
  const expected = requireSecret(env, "ADMIN_TOKEN");
  if (!candidate || !(await secureTokenEqual(candidate, expected))) {
    throw new HttpError(401, "admin_authentication_required", "A valid admin token is required");
  }
}

export async function authenticateInternalRequest(request: Request, env: Env): Promise<void> {
  const candidate = request.headers.get("X-Relay-Internal") ?? "";
  const expected = requireSecret(env, "INTERNAL_DO_SECRET");
  if (candidate.length > 256 || !(await secureTokenEqual(candidate, expected))) {
    throw new HttpError(403, "forbidden", "Internal request denied");
  }
}

export function internalHeaders(env: Env): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-Relay-Internal": requireSecret(env, "INTERNAL_DO_SECRET"),
  };
}

export function clerkPrincipalFromVerification(result: unknown): ClerkPrincipal {
  if (!result || typeof result !== "object") throw new Error("invalid Clerk verification result");
  // @clerk/backend's public verifyToken() returns the verified JwtPayload
  // directly. Accept the older low-level {data, errors} shape too so a patch
  // release cannot turn every valid production session into a 401.
  const verified = result as {
    sub?: unknown;
    sid?: unknown;
    data?: { sub?: unknown; sid?: unknown };
    errors?: unknown;
  };
  const legacyShape = Object.hasOwn(verified, "data");
  if (legacyShape && (verified.errors || !verified.data)) {
    throw new Error("Clerk token verification failed");
  }
  const payload = legacyShape ? verified.data! : verified;
  if (typeof payload.sub !== "string" || !/^user_[A-Za-z0-9]+$/.test(payload.sub)) {
    throw new Error("missing Clerk subject");
  }
  return {
    userId: payload.sub,
    sessionId: typeof payload.sid === "string" ? payload.sid : undefined,
  };
}
