import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const MAX_PROXY_HEADER_BYTES = 64 * 1024;

type SiteTransportResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  setCookie: string[];
  bytes: Buffer;
  truncated: boolean;
  length: number;
};

function targetAuthority(target: URL) {
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
  return {
    hostname,
    port,
    authority: net.isIP(hostname) === 6 ? `[${hostname}]:${port}` : `${hostname}:${port}`,
  };
}

function openProxyTunnel(proxyPort: number, target: URL, timeoutMs: number) {
  return new Promise<net.Socket>((resolve, reject) => {
    const { authority } = targetAuthority(target);
    const socket = net.createConnection({ host: "127.0.0.1", port: proxyPort });
    let pending = Buffer.alloc(0);
    let settled = false;
    const finish = (error: Error | null, value?: net.Socket) => {
      if (settled) return;
      settled = true;
      socket.off("data", onData);
      socket.off("error", onError);
      socket.setTimeout(0);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(value);
      }
    };
    const onError = (error: Error) => finish(error);
    const onData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > MAX_PROXY_HEADER_BYTES) {
        finish(new Error("Guard proxy returned an oversized CONNECT response."));
        return;
      }
      const boundary = pending.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const head = pending.subarray(0, boundary).toString("latin1");
      const status = /^HTTP\/1\.[01]\s+(\d{3})/i.exec(head)?.[1];
      if (status !== "200") {
        finish(new Error(`Guard proxy refused the site request (${status || "invalid response"}).`));
        return;
      }
      const remainder = pending.subarray(boundary + 4);
      if (remainder.length) socket.unshift(remainder);
      finish(null, socket);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error("Timed out connecting through the guard proxy.")));
    socket.once("error", onError);
    socket.once("connect", () => {
      socket.on("data", onData);
      socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\nConnection: keep-alive\r\n\r\n`);
    });
  });
}

function secureTunnel(socket: net.Socket, target: URL, timeoutMs: number) {
  return new Promise<tls.TLSSocket>((resolve, reject) => {
    const { hostname } = targetAuthority(target);
    const tlsOptions: tls.ConnectionOptions = {
      socket,
      ALPNProtocols: ["http/1.1"],
    };
    // SNI is only valid for names; RFC 6066 forbids literal IP addresses.
    if (!net.isIP(hostname)) tlsOptions.servername = hostname;
    const secured = tls.connect(tlsOptions);
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      secured.setTimeout(0);
      secured.off("error", onError);
      if (error) {
        secured.destroy();
        reject(error);
      } else {
        resolve(secured);
      }
    };
    const onError = (error: Error) => finish(error);
    secured.setTimeout(timeoutMs, () => finish(new Error("Timed out negotiating site TLS.")));
    secured.once("error", onError);
    secured.once("secureConnect", () => finish(null));
  });
}

function responseHeaders(response: http.IncomingMessage) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return headers;
}

export async function requestSiteResponse({
  target,
  proxyPort,
  method,
  headers,
  body,
  timeoutMs,
  limit,
}: {
  target: string | URL;
  proxyPort: number;
  method: string;
  headers: Record<string, string>;
  body?: string | Buffer;
  timeoutMs: number;
  limit: number;
}): Promise<SiteTransportResponse> {
  const url = target instanceof URL ? target : new URL(String(target));
  const tunnel = await openProxyTunnel(proxyPort, url, timeoutMs);
  const connection = url.protocol === "https:"
    ? await secureTunnel(tunnel, url, timeoutMs)
    : tunnel;
  const { hostname, port } = targetAuthority(url);
  const client = url.protocol === "https:" ? https : http;
  return new Promise<SiteTransportResponse>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, value?: SiteTransportResponse) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const request = client.request(
      {
        protocol: url.protocol,
        hostname,
        port: String(port),
        method,
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, host: url.host },
        agent: false,
        createConnection: () => connection,
      },
      (response) => {
        const normalizedHeaders = responseHeaders(response);
        const setCookie = response.headers["set-cookie"] || [];
        const declaredLength = /^\d+$/.test(normalizedHeaders["content-length"] || "")
          ? Number(normalizedHeaders["content-length"])
          : null;
        const redirect = [301, 302, 303, 307, 308].includes(response.statusCode || 0) &&
          Boolean(normalizedHeaders.location);
        if (redirect) {
          response.destroy();
          finish(null, {
            status: response.statusCode || 0,
            statusText: response.statusMessage || "",
            headers: normalizedHeaders,
            setCookie,
            bytes: Buffer.alloc(0),
            truncated: false,
            length: declaredLength || 0,
          });
          return;
        }
        const chunks: Buffer[] = [];
        let retained = 0;
        let observed = 0;
        const complete = (truncated: boolean) => {
          finish(null, {
            status: response.statusCode || 0,
            statusText: response.statusMessage || "",
            headers: normalizedHeaders,
            setCookie,
            bytes: Buffer.concat(chunks, retained),
            truncated,
            length: declaredLength ?? observed,
          });
        };
        response.on("data", (rawChunk) => {
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          observed += chunk.length;
          if (retained < limit) {
            const kept = chunk.subarray(0, limit - retained);
            chunks.push(kept);
            retained += kept.length;
          }
          if (observed > limit || (declaredLength !== null && declaredLength > limit && retained >= limit)) {
            complete(true);
            response.destroy();
          }
        });
        response.once("end", () => complete(observed > limit));
        response.once("error", (error) => {
          if (!settled) finish(error);
        });
      },
    );
    request.setTimeout(timeoutMs, () => request.destroy(new Error("site.request timed out.")));
    request.once("error", (error) => {
      connection.destroy();
      finish(error);
    });
    if (body !== undefined) request.write(body);
    request.end();
  });
}

export function cookiesFromSetCookie(headers: string | string[], target: string | URL) {
  const url = target instanceof URL ? target : new URL(String(target));
  const values = Array.isArray(headers) ? headers : headers ? [headers] : [];
  const cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }> = [];
  for (const header of values) {
    const parts = String(header).split(";").map((part) => part.trim());
    const first = parts.shift() || "";
    const separator = first.indexOf("=");
    if (separator <= 0) continue;
    const cookie: (typeof cookies)[number] = {
      name: first.slice(0, separator),
      value: first.slice(separator + 1),
      domain: url.hostname,
      path: "/",
      expires: -1,
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    };
    for (const part of parts) {
      const [rawName, ...rawValue] = part.split("=");
      const name = rawName.toLowerCase();
      const value = rawValue.join("=");
      if (name === "domain" && value) cookie.domain = value;
      else if (name === "path" && value.startsWith("/")) cookie.path = value;
      else if (name === "expires") {
        const expires = Date.parse(value);
        if (Number.isFinite(expires)) cookie.expires = Math.floor(expires / 1_000);
      } else if (name === "max-age" && /^-?\d+$/.test(value)) {
        cookie.expires = Math.max(0, Math.floor(Date.now() / 1_000) + Number(value));
      } else if (name === "httponly") cookie.httpOnly = true;
      else if (name === "secure") cookie.secure = true;
      else if (name === "samesite" && /^(strict|lax|none)$/i.test(value)) {
        // SAFETY: the regex admits only strict/lax/none in any case, and
        // first-letter-upper + rest-lower maps those onto exactly these literals.
        cookie.sameSite = `${value[0].toUpperCase()}${value.slice(1).toLowerCase()}` as
          "Strict" | "Lax" | "None";
      }
    }
    cookies.push(cookie);
  }
  return cookies;
}
