import {
  CAPABILITY_BYTES,
  HOST_PROTOCOL_PREFIX,
  RELAY_PROTOCOL,
  VIEWER_PROTOCOL_PREFIX,
} from "./constants";
import { base64UrlToBytes } from "./crypto";

export type PeerRole = "host" | "viewer";

export interface PresentedCapability {
  role: PeerRole;
  capability: string;
}

export type HostLifecycleEvent =
  | "host_ready"
  | "viewer_connected"
  | "viewer_disconnected"
  | "lease_expiring"
  | "lease_expired"
  | "quota_exhausted"
  | "budget_exhausted"
  | "session_expired"
  | "session_closed"
  | "kill_switch";

export function parseWebSocketProtocols(header: string | null): PresentedCapability | null {
  if (!header || header.length > 512) return null;
  const protocols = header.split(",").map((entry) => entry.trim());
  if (protocols.length !== 2 || protocols[0] !== RELAY_PROTOCOL) return null;
  const credential = protocols[1];
  let role: PeerRole;
  let capability: string;
  if (credential.startsWith(HOST_PROTOCOL_PREFIX)) {
    role = "host";
    capability = credential.slice(HOST_PROTOCOL_PREFIX.length);
  } else if (credential.startsWith(VIEWER_PROTOCOL_PREFIX)) {
    role = "viewer";
    capability = credential.slice(VIEWER_PROTOCOL_PREFIX.length);
  } else {
    return null;
  }
  try {
    base64UrlToBytes(capability, CAPABILITY_BYTES);
  } catch {
    return null;
  }
  return { role, capability };
}

export function hostControlNotice(
  event: HostLifecycleEvent,
  fields: Record<string, string | number | boolean | null> = {},
): string {
  return JSON.stringify({ t: "relay", event, ...fields });
}

export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

export function acceptedWebSocketResponse(client: WebSocket): Response {
  return new Response(null, {
    status: 101,
    webSocket: client,
    headers: { "Sec-WebSocket-Protocol": RELAY_PROTOCOL },
  });
}

/** Return a real WebSocket close code to browser callers instead of a vague HTTP failure. */
export function rejectedWebSocketResponse(code: number, reason: string): Response {
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  server.close(code, reason.slice(0, 120));
  return acceptedWebSocketResponse(client);
}
