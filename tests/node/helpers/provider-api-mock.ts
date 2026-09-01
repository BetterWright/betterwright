// In-process stand-in for the six REST-lifecycle cloud browser APIs.
//
// Tests inject this as `fetchJson` so a connect → start → list → show → stop
// pass never leaves the process. Each provider is keyed by a mock API key;
// a wrong key throws the same shape of error the real httpJson helper would.

const KEYS = {
  kernel: "k_live_test",
  browserbase: "bb_live_test",
  steel: "st_live_test",
  anchor: "an_live_test",
  hyperbrowser: "hb_live_test",
  "browser-use": "bu_live_test",
};

function unauthorized(method, url): never {
  throw new Error(`Cloud browser API ${method} ${url} failed with HTTP 401: invalid API key`);
}

function notFound(method, url): never {
  throw new Error(`Cloud browser API ${method} ${url} failed with HTTP 404: session not found`);
}

function header(request, name) {
  const headers = request?.headers || {};
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === wanted) return String(value);
  }
  return "";
}

function bearer(request) {
  return header(request, "authorization").replace(/^bearer\s+/i, "");
}

interface MockSessionRecord {
  id: string;
  status: string;
  provider: string;
  cdp_url?: string;
  live_view_url?: string;
  cdp_ws_url?: string;
  browser_live_view_url?: string;
  connectUrl?: string;
  debuggerFullscreenUrl?: string;
  sessionViewerUrl?: string;
  wsEndpoint?: string;
  liveUrl?: string;
  cdpUrl?: string;
}

export function createProviderApiMock(options: { keys?: Record<string, string> } = {}) {
  const keys = { ...KEYS, ...options.keys };
  const boxes = new Map<string, Map<string, MockSessionRecord>>();
  let seq = 0;
  const calls = [];

  function store(provider): Map<string, MockSessionRecord> {
    const existing = boxes.get(provider);
    if (existing) return existing;
    const created = new Map<string, MockSessionRecord>();
    boxes.set(provider, created);
    return created;
  }

  function mint(provider, extra: Partial<MockSessionRecord> = {}): MockSessionRecord {
    seq += 1;
    const id = extra.id || `${provider.replace(/[^a-z]/g, "").slice(0, 6)}_${seq}`;
    const record: MockSessionRecord = {
      id,
      status: extra.status || "running",
      provider,
      ...extra,
    };
    store(provider).set(record.id, record);
    return record;
  }

  function requireBox(provider, id, method, url) {
    const record = store(provider).get(id);
    if (!record) notFound(method, url);
    return record;
  }

  function checkKey(provider, presented, method, url) {
    if (presented !== keys[provider]) unauthorized(method, url);
  }

  async function fetchJson(url, request) {
    calls.push({ url, method: request.method, headers: request.headers, body: request.body });
    const method = String(request.method || "GET").toUpperCase();
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/$/, "") || "/";

    if (parsed.host === "api.onkernel.com") {
      checkKey("kernel", bearer(request), method, url);
      if (method === "POST" && path === "/browsers") {
        return mint("kernel", {
          status: "active",
          cdp_ws_url: `wss://onkernel.example/devtools/${seq}`,
          browser_live_view_url: `https://live.onkernel.example/${seq}`,
        });
      }
      if (method === "GET" && path === "/browsers") {
        return [...store("kernel").values()];
      }
      const kernelId = path.match(/^\/browsers\/([^/]+)$/)?.[1];
      if (kernelId && method === "GET") {
        return requireBox("kernel", kernelId, method, url);
      }
      if (kernelId && method === "DELETE") {
        requireBox("kernel", kernelId, method, url);
        store("kernel").delete(kernelId);
        return null;
      }
    }

    if (parsed.host === "api.browserbase.com") {
      checkKey("browserbase", header(request, "x-bb-api-key"), method, url);
      if (path === "/v1/sessions" && method === "POST") {
        const id = `sess_${seq + 1}`;
        return mint("browserbase", {
          id,
          status: "RUNNING",
          connectUrl: `wss://connect.browserbase.com/devtools/${id}`,
          debuggerFullscreenUrl: `https://www.browserbase.com/sessions/${id}`,
        });
      }
      if (path === "/v1/sessions" && method === "GET") {
        const status = parsed.searchParams.get("status");
        return [...store("browserbase").values()].filter(
          (row) => !status || row.status === status,
        );
      }
      const bbId = path.match(/^\/v1\/sessions\/([^/]+)$/)?.[1];
      if (bbId && method === "GET") return requireBox("browserbase", bbId, method, url);
      if (bbId && method === "POST") {
        const record = requireBox("browserbase", bbId, method, url);
        if (request.body?.status === "REQUEST_RELEASE") {
          store("browserbase").delete(bbId);
          return { ...record, status: "COMPLETED" };
        }
        return record;
      }
    }

    if (parsed.host === "api.steel.dev") {
      checkKey("steel", header(request, "steel-api-key"), method, url);
      if (path === "/v1/sessions" && method === "POST") {
        const id = `steel_${seq + 1}`;
        return mint("steel", {
          id,
          status: "live",
          sessionViewerUrl: `https://app.steel.dev/sessions/${id}`,
        });
      }
      if (path === "/v1/sessions" && method === "GET") {
        return { sessions: [...store("steel").values()] };
      }
      const steelRelease = path.match(/^\/v1\/sessions\/([^/]+)\/release$/)?.[1];
      if (steelRelease && method === "POST") {
        requireBox("steel", steelRelease, method, url);
        store("steel").delete(steelRelease);
        return { success: true };
      }
      const steelId = path.match(/^\/v1\/sessions\/([^/]+)$/)?.[1];
      if (steelId && method === "GET") return requireBox("steel", steelId, method, url);
    }

    if (parsed.host === "api.hyperbrowser.ai") {
      checkKey("hyperbrowser", header(request, "x-api-key"), method, url);
      if (path === "/api/session" && method === "POST") {
        const id = `hb_${seq + 1}`;
        return mint("hyperbrowser", {
          id,
          status: "active",
          wsEndpoint: `wss://hyper.example/${id}`,
          liveUrl: `https://app.hyperbrowser.ai/live/${id}`,
        });
      }
      if (path === "/api/sessions" && method === "GET") {
        return { sessions: [...store("hyperbrowser").values()], totalCount: store("hyperbrowser").size };
      }
      const hbStop = path.match(/^\/api\/session\/([^/]+)\/stop$/)?.[1];
      if (hbStop && method === "POST") {
        requireBox("hyperbrowser", hbStop, method, url);
        store("hyperbrowser").delete(hbStop);
        return { success: true };
      }
      const hbId = path.match(/^\/api\/session\/([^/]+)$/)?.[1];
      if (hbId && method === "GET") return requireBox("hyperbrowser", hbId, method, url);
    }

    if (parsed.host === "api.anchorbrowser.io") {
      checkKey("anchor", header(request, "anchor-api-key"), method, url);
      if (path === "/api/v1/sessions" && method === "POST") {
        const id = `anch_${seq + 1}`;
        const record = mint("anchor", {
          id,
          status: "running",
          cdp_url: `wss://anchor.example/${id}`,
          live_view_url: `https://live.anchorbrowser.io/${id}`,
        });
        return {
          data: {
            id: record.id,
            cdp_url: record.cdp_url,
            live_view_url: record.live_view_url,
          },
        };
      }
      if (path === "/api/v1/sessions" && method === "GET") {
        return {
          data: [...store("anchor").values()].map((row) => ({
            id: row.id,
            status: row.status,
            live_view_url: row.live_view_url,
          })),
        };
      }
      const anchId = path.match(/^\/api\/v1\/sessions\/([^/]+)$/)?.[1];
      if (anchId && method === "GET") {
        const row = requireBox("anchor", anchId, method, url);
        return { data: row };
      }
      if (anchId && method === "DELETE") {
        requireBox("anchor", anchId, method, url);
        store("anchor").delete(anchId);
        return { data: { status: "ended" } };
      }
    }

    if (parsed.host === "api.browser-use.com") {
      checkKey("browser-use", header(request, "x-browser-use-api-key"), method, url);
      if (path === "/api/v4/browsers" && method === "POST") {
        const id = `bu_${seq + 1}`;
        return mint("browser-use", {
          id,
          status: "active",
          cdpUrl: `wss://connect.browser-use.com/browsers/${id}`,
          liveUrl: `https://cloud.browser-use.com/live/${id}`,
        });
      }
      if (path === "/api/v4/browsers" && method === "GET") {
        return { browsers: [...store("browser-use").values()] };
      }
      const buId = path.match(/^\/api\/v4\/browsers\/([^/]+)$/)?.[1];
      if (buId && method === "GET") return requireBox("browser-use", buId, method, url);
      if (buId && method === "PATCH") {
        if (request.body?.action !== "stop") {
          throw new Error(`Cloud browser API PATCH ${url} failed with HTTP 400: unknown action`);
        }
        requireBox("browser-use", buId, method, url);
        store("browser-use").delete(buId);
        return { id: buId, status: "stopped" };
      }
    }

    throw new Error(`Cloud browser API ${method} ${url} failed with HTTP 404: no mock route`);
  }

  return { fetchJson, keys, calls, boxes, mint };
}

export { KEYS as MOCK_PROVIDER_KEYS };
