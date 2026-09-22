// Per-page request history, guarded same-origin requests, and WebAgents discovery.
import type { BrowserContext } from "playwright-core";
import { compactAutomaticUI, hasReturnedUIDirectory } from "./automatic-ui.js";
import type { createGuardUrl } from "./guard-url.js";
import { inspectActionDirectory } from "./page-inspect.js";
import { cookiesFromSetCookie, requestSiteResponse } from "./site-request.js";
import { normalizeSiteHeaders, SITE_RESPONSE_LIMIT, sameOriginSiteUrl } from "./site-tools.js";
import { parseWebAgentsDocument, publicWebAgentsManifest, WEBAGENTS_DISCOVERY_PATHS, WebAgentsPathScopeError } from "./webagents.js";

const MAX_SITE_REQUESTS = 512;

interface WorkerSiteDeps {
  getBrowserContext: () => BrowserContext;
  getProxyPort: () => number;
  guardUrl: ReturnType<typeof createGuardUrl>;
  transportExecuteId: () => string;
  navigationTimeoutMs: number;
}

export function createWorkerSite({
  getBrowserContext,
  getProxyPort,
  guardUrl,
  transportExecuteId,
  navigationTimeoutMs: DEFAULT_NAVIGATION_TIMEOUT_MS,
}: WorkerSiteDeps) {
  const pageSiteRequests = new WeakMap();
  const pageWebAgentsDiscovery = new WeakMap();
  const requestSiteRecord = new WeakMap();

  // One observed page request, filled in as its response or failure arrives.
  interface SiteRequestRecord {
    method: string;
    url: string;
    resourceType: string;
    status: number | null;
    mimeType: string;
    failure: string;
    at: number;
  }

  function rememberSiteRequest(page, request) {
    const records = pageSiteRequests.get(page) || [];
    pageSiteRequests.set(page, records);
    const record: SiteRequestRecord = {
      method: String(request.method() || "GET"),
      url: String(request.url() || ""),
      resourceType: String(request.resourceType() || "other"),
      status: null,
      mimeType: "",
      failure: "",
      at: Date.now(),
    };
    records.push(record);
    if (records.length > MAX_SITE_REQUESTS)
      records.splice(0, records.length - MAX_SITE_REQUESTS);
    requestSiteRecord.set(request, record);
  }

  async function pageSiteRequest(page, url, options: any = {}) {
    let target = sameOriginSiteUrl(page.url(), url);
    let method = String(options.method || "GET").trim().toUpperCase();
    if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
      throw new Error("site.request method must be GET, HEAD, POST, PUT, PATCH, or DELETE.");
    }
    const headers: Record<string, string> = normalizeSiteHeaders(options.headers);
    let body;
    if (Object.hasOwn(options, "json")) {
      body = JSON.stringify(options.json);
      headers["content-type"] ||= "application/json";
    } else if (Object.hasOwn(options, "body")) {
      body = String(options.body);
    }
    if (body && Buffer.byteLength(body) > SITE_RESPONSE_LIMIT) {
      throw new Error(`site.request body exceeds ${SITE_RESPONSE_LIMIT} bytes.`);
    }
    const pageUrl = page.url();
    headers.origin ||= new URL(pageUrl).origin;
    headers.referer ||= pageUrl;
    headers["accept-encoding"] ||= "identity";
    let response;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const decision = await guardUrl(
        target,
        { method, resourceType: "fetch", siteHelper: true },
        transportExecuteId(),
      );
      if (!decision?.allowed) {
        throw new Error(decision?.reason || "site.request was blocked by policy.");
      }
      const requestHeaders = { ...headers };
      const cookieHeader = (await getBrowserContext().cookies(target).catch(() => []))
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join("; ");
      if (cookieHeader) requestHeaders.cookie = cookieHeader;
      response = await requestSiteResponse({
        target,
        proxyPort: getProxyPort(),
        method,
        headers: requestHeaders,
        body:
          body !== undefined && !["GET", "HEAD"].includes(method)
            ? body
            : undefined,
        timeoutMs: DEFAULT_NAVIGATION_TIMEOUT_MS,
        limit: SITE_RESPONSE_LIMIT,
      });
      const responseCookies = cookiesFromSetCookie(response.setCookie, target);
      if (responseCookies.length) {
        await getBrowserContext().addCookies(responseCookies).catch(() => {});
      }
      const location = response.headers.location;
      if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
        break;
      }
      if (redirects === 5) throw new Error("site.request exceeded 5 redirects.");
      target = sameOriginSiteUrl(pageUrl, new URL(location, target).href);
      if (response.status === 303 ||
        ([301, 302].includes(response.status) && method === "POST")) {
        method = "GET";
        body = undefined;
      }
    }
    const bytes = response.bytes;
    const text = bytes.toString("utf8");
    const responseHeaders = response.headers;
    const result = {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      statusText: response.statusText,
      url: target,
      contentType: responseHeaders["content-type"] || "",
      text,
      truncated: response.truncated,
      length: response.length,
    };
    const records = pageSiteRequests.get(page) || [];
    records.push({
      method,
      url: result.url,
      resourceType: "fetch",
      status: result.status,
      mimeType: result.contentType.split(";", 1)[0].trim(),
      failure: "",
      at: Date.now(),
    });
    if (records.length > MAX_SITE_REQUESTS) {
      records.splice(0, records.length - MAX_SITE_REQUESTS);
    }
    pageSiteRequests.set(page, records);
    if (options.response === "json") {
      try {
        return { ...result, json: result.text ? JSON.parse(result.text) : null };
      } catch {
        throw new Error(`site.request expected JSON but received ${result.contentType || "unknown content"}.`);
      }
    }
    return result;
  }

  async function discoverPageWebAgents(page, { refresh = false }: any = {}) {
    let origin;
    let pathname;
    try {
      const activeUrl = new URL(page.url());
      origin = activeUrl.origin;
      pathname = activeUrl.pathname;
    } catch {
      return {
        manifest: null,
        error: "WebAgents discovery requires an open HTTP(S) page.",
      };
    }
    const cached = pageWebAgentsDiscovery.get(page);
    if (
      !refresh &&
      cached?.origin === origin &&
      (
        cached.pathname === pathname ||
        (!cached.manifest && cached.pathScoped !== true)
      )
    ) return cached;

    const errors: string[] = [];
    let pathScoped = false;
    const probes = await Promise.all(WEBAGENTS_DISCOVERY_PATHS.map(async (path) => {
      try {
        return { path, response: await pageSiteRequest(page, path, { method: "GET" }) };
      } catch (error) {
        return { path, error };
      }
    }));
    for (const probe of probes) {
      const { path } = probe;
      if ("error" in probe) {
        errors.push(`${path}: ${probe.error?.message || probe.error}`);
        continue;
      }
      const { response } = probe;
      if (response.status === 404 || response.status === 410) continue;
      if (!response.ok) {
        errors.push(`${path}: HTTP ${response.status}`);
        continue;
      }
      try {
        const manifest = parseWebAgentsDocument(
          response.text,
          response.url,
          page.url(),
        );
        const entry = { origin, pathname, manifest, error: "" };
        pageWebAgentsDiscovery.set(page, entry);
        return entry;
      } catch (error) {
        if (error instanceof WebAgentsPathScopeError) pathScoped = true;
        errors.push(`${path}: ${error?.message || error}`);
      }
    }
    const entry = {
      origin,
      pathname,
      manifest: null,
      pathScoped,
      error: errors[0] || "This origin does not publish WebAgents.",
    };
    pageWebAgentsDiscovery.set(page, entry);
    return entry;
  }

  async function unannouncedWebAgentsDirectory(session) {
    const page = session.pages.get(session.currentId);
    if (!page || page.isClosed()) return null;
    let origin;
    try {
      const url = new URL(page.url());
      if (!new Set(["http:", "https:"]).has(url.protocol)) return null;
      origin = `${url.origin}${url.pathname}`;
    } catch {
      return null;
    }
    if (session.webAgentsAnnouncedOrigins.has(origin)) return null;
    session.webAgentsAnnouncedOrigins.add(origin);
    const discovered = await discoverPageWebAgents(page);
    return discovered.manifest ? publicWebAgentsManifest(discovered.manifest) : null;
  }

  async function unannouncedUIDirectory(session, result) {
    const page = session.pages.get(session.currentId);
    if (!page || page.isClosed()) return null;
    let key;
    try {
      const url = new URL(page.url());
      if (!new Set(["http:", "https:"]).has(url.protocol)) return null;
      key = `${url.origin}${url.pathname}`;
    } catch {
      return null;
    }
    if (session.uiDirectoryAnnouncedOrigins.has(key)) return null;
    const discovered = pageWebAgentsDiscovery.get(page);
    if (!discovered || discovered.manifest) return null;
    session.uiDirectoryAnnouncedOrigins.add(key);
    if (hasReturnedUIDirectory(result)) return null;
    const directory = await inspectActionDirectory(page);
    return directory.controls.length ? compactAutomaticUI(directory) : null;
  }

  async function inspectSiteAssets(page) {
    const domAssets = await page.evaluate(() =>
      [
        ...[...document.scripts].map((element) => ({
          url: element.src,
          resourceType: "script",
        })),
        ...[...document.querySelectorAll('link[rel~="stylesheet"]')].map(
          (element: HTMLLinkElement) => ({
            url: element.href,
            resourceType: "stylesheet",
          }),
        ),
      ].filter((entry) => entry.url),
    );
    const networkAssets = (pageSiteRequests.get(page) || [])
      .filter((record) =>
        ["script", "stylesheet", "fetch", "xhr"].includes(record.resourceType),
      )
      .map(({ url, resourceType, status, mimeType }) => ({
        url,
        resourceType,
        status,
        mimeType,
      }));
    const unique = new Map();
    for (const asset of [...domAssets, ...networkAssets]) {
      if (!unique.has(asset.url)) unique.set(asset.url, asset);
    }
    return [...unique.values()].slice(0, MAX_SITE_REQUESTS);
  }

  return {
    pageSiteRequests,
    requestSiteRecord,
    rememberSiteRequest,
    pageSiteRequest,
    discoverPageWebAgents,
    unannouncedWebAgentsDirectory,
    unannouncedUIDirectory,
    inspectSiteAssets,
  };
}
