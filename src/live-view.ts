// Live-view server: watch — and optionally drive — the worker's browser from
// an ordinary web browser.
//
// Runs inside the browser worker, next to the CDP sessions frames come from:
// CDP Page.startScreencast JPEG frames go out as binary WebSocket frames, and
// viewer mouse/keyboard comes back in as Input.dispatch* on the same page.
// Human input therefore flows through every existing guard — the SOCKS policy
// proxy, download limits, credential capture — exactly like model-driven
// navigation. Takeover does not bypass policy.
//
// Security model (self-host): the listener is off by default; bind defaults to
// all interfaces with a LAN publicHost so printed URLs open from another
// machine on the network. Every HTTP request and WebSocket upgrade must present
// the per-start capability token (`?t=...`). Watch-only vs interactive is
// enforced here, server-side; the viewer's "take control" toggle is a
// client-side convenience, never an authority. Nothing in this module is
// reachable from the model sandbox.
//
// Dependencies are injected (pages, CDP factory, activity hook) so unit tests
// drive the whole server with fakes — the same seam style as createGuardProxy
// and installVaultCapture.

import crypto from "node:crypto";
import http from "node:http";
import os from "node:os";

import type { LiveViewStatus } from "../types/public.js";
import {
  encodeBinaryFrame,
  isWebSocketUpgrade,
  upgradeWebSocket,
} from "./live-view-ws.js";
import { isCallable, isString, type UntrustedValue } from "./untrusted-value.js";

const DEFAULT_QUALITY = 60;
const DEFAULT_MAX_DIMENSION = 1440;

/**
 * Find this machine's Tailscale IPv4 (CGNAT 100.64.0.0/10, the range Tailscale
 * assigns). Returns "" when no tailnet address is up. Interface injection is
 * for tests only.
 */
export function guessTailscaleHost(interfaces = os.networkInterfaces()) {
  for (const addrs of Object.values(interfaces)) {
    for (const entry of addrs || []) {
      // SAFETY: Node before 18.4 reported the address family as the number 4,
      // which the modern "IPv4" | "IPv6" declaration elides; the widening
      // readmits the documented legacy value for the comparison.
      const v4 =
        (entry.family as string | number) === "IPv4" ||
        (entry.family as string | number) === 4;
      if (!v4 || entry.internal) continue;
      const octets = String(entry.address).split(".").map(Number);
      if (octets.length === 4 && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) {
        return entry.address;
      }
    }
  }
  return "";
}

/**
 * Prefer a private LAN IPv4 for printed live-view URLs (skip docker / link-local).
 * Falls back to 127.0.0.1 only when no external IPv4 is available.
 */
export function guessLanHost() {
  const preferred = [];
  const others = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const entry of addrs || []) {
      // SAFETY: Node before 18.4 reported the address family as the number 4,
      // which the modern "IPv4" | "IPv6" declaration elides; the widening
      // readmits the documented legacy value for the comparison.
      const v4 =
        (entry.family as string | number) === "IPv4" ||
        (entry.family as string | number) === 4;
      if (!v4 || entry.internal) continue;
      const ip = entry.address;
      if (
        ip.startsWith("169.254.") ||
        ip.startsWith("172.17.") ||
        ip.startsWith("172.18.") ||
        ip.startsWith("172.19.")
      ) {
        continue;
      }
      if (ip.startsWith("192.168.") || ip.startsWith("10.")) preferred.push(ip);
      else others.push(ip);
    }
  }
  return preferred[0] || others[0] || "127.0.0.1";
}

/** Default bind: all interfaces + LAN hostname in the printed URL. */
export function defaultLiveViewListen() {
  return { host: "0.0.0.0", publicHost: guessLanHost() };
}
// Latest-frame-wins: skip a viewer whose socket backlog exceeds this instead
// of queueing unbounded JPEG history on a slow tunnel.
const BACKPRESSURE_LIMIT = 1_500_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
const TABS_REFRESH_INTERVAL_MS = 3_000;
const TITLE_TIMEOUT_MS = 250;
// Tab-strip previews are captured at the page's native scale. Chromium can
// retain a scaled Page.captureScreenshot surface on the page, so requesting a
// 320px capture here can make a later screencast inherit that resolution.
// Cache each preview until the tab becomes active to keep native-scale capture
// work bounded.
const THUMB_QUALITY = 40;
const THUMB_TIMEOUT_MS = 800;
// stop() must never hang on a wedged browser transport (e.g. Chromium died
// mid-shutdown): CDP teardown is best-effort under this cap, after the
// listener itself is already released.
const STOP_TEARDOWN_TIMEOUT_MS = 1_500;
// Viewers report their viewport in device pixels so the screencast never
// streams more resolution than the largest window can show. Sizes are bucketed
// and the restart debounced so window-resize drags don't thrash CDP.
const VIEWPORT_BUCKET_PX = 160;
const VIEWPORT_APPLY_DEBOUNCE_MS = 300;
// Optional password gate on top of the capability token: browser sessions ride
// an HttpOnly cookie; failed logins back off per source address.
const SESSION_COOKIE = "bw_lv_sess";
const SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const SESSION_LIMIT = 200;
const LOGIN_MAX_FAILURES = 10;
const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1_000;
const LOGIN_BODY_LIMIT = 4_096;
const MIN_PASSWORD_LENGTH = 4;
const EXPOSE_MODES = new Set(["", "lan", "local", "tailscale"]);

// Unstyled fallback login form; the worker injects the branded page from
// live-view-html.ts. Kept functional so tests and bare embedders still work.
function defaultLoginHtml() {
  return (
    "<!doctype html><meta charset=\"utf-8\"><title>BetterWright — Live View</title>" +
    "<form id=\"f\" method=\"post\"><h1>Live view is locked</h1>" +
    "<input type=\"password\" name=\"password\" placeholder=\"Password\" autofocus required>" +
    "<button type=\"submit\">Unlock</button></form>" +
    "<script>document.getElementById('f').action='/login'+location.search;</script>"
  );
}

// Viewer-initiated navigation is confined to the web: no file://, chrome://,
// javascript:, or extension pages — anything else the policy proxy could not
// see or that would execute in the page with viewer authority.
const ALLOWED_NAV_PROTOCOLS = new Set(["http:", "https:"]);
const MAX_NAV_URL_LENGTH = 4_096;

/**
 * Turn whatever a human typed into the viewer's address bar into a safe
 * navigable URL, mirroring a real browser omnibox: full URLs pass through
 * (http/https only), bare hosts get https://, host:port works, and anything
 * that doesn't look like an address becomes a web search. Returns "" when the
 * input is empty or resolves to a forbidden scheme.
 */
export function normalizeViewerUrl(input) {
  const raw = String(input || "").trim().slice(0, MAX_NAV_URL_LENGTH);
  if (!raw) return "";
  if (raw === "about:blank") return raw;
  // "localhost:3000/path" parses as scheme "localhost:"; catch host:port first.
  if (/^[a-z0-9][a-z0-9.-]*:\d{1,5}(\/|\?|#|$)/i.test(raw)) {
    try {
      return new URL(`http://${raw}`).href;
    } catch {
      return "";
    }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    try {
      const parsed = new URL(raw);
      return ALLOWED_NAV_PROTOCOLS.has(parsed.protocol) ? parsed.href : "";
    } catch {
      return "";
    }
  }
  if (!/\s/.test(raw) && (raw.includes(".") || /^localhost(\/|$)/i.test(raw))) {
    try {
      return new URL(`https://${raw}`).href;
    } catch {
      /* fall through to search */
    }
  }
  return `https://www.google.com/search?q=${encodeURIComponent(raw)}`;
}

const MOUSE_EVENT_TYPES = new Set([
  "mousePressed",
  "mouseReleased",
  "mouseMoved",
  "mouseWheel",
]);
const KEY_EVENT_TYPES = new Set(["keyDown", "keyUp", "rawKeyDown", "char"]);
const MOUSE_BUTTONS = new Set(["none", "left", "middle", "right", "back", "forward"]);

// CDP Input.dispatchMouseEvent / Input.dispatchKeyEvent payloads, built only
// from clamped and allowlisted viewer values.
interface MouseEventParams {
  type: string;
  x: number;
  y: number;
  button: string;
  buttons: number;
  clickCount: number;
  modifiers: number;
  deltaX?: number;
  deltaY?: number;
}

interface KeyEventParams {
  type: string;
  modifiers: number;
  key: string;
  code: string;
  windowsVirtualKeyCode?: number;
  nativeVirtualKeyCode?: number;
  text?: string;
}

// The openPage dependency hands back the worker's Playwright Page (tests
// inject fakes); only closability is probed here.
interface OpenedPageLike {
  isClosed?(): boolean;
}

function isTabOpener(value: UntrustedValue): value is () => Promise<OpenedPageLike> {
  return isCallable(value);
}

function finiteNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * @param {object} deps
 * @param {() => string} deps.html the viewer page markup
 * @param {() => Array<{id: string, page: object, sessionId: string, active: boolean}>} deps.listPages
 * @param {() => (object|null)} [deps.preferredPage] page to stream first
 * @param {(page: object) => Promise<object>} deps.newCDPSession
 * @param {() => Promise<object>} [deps.openPage] open a new tab in the viewed session (enables the viewer's + button)
 * @param {(page: object) => void} [deps.onHumanActivity]
 * @param {(message: string) => void} [deps.log]
 */
export function createLiveViewServer({
  html,
  loginHtml = defaultLoginHtml,
  listPages,
  preferredPage = () => null,
  newCDPSession,
  openPage = null,
  onHumanActivity = () => {},
  log = () => {},
}: any) {
  let server = null;
  let running = false;
  let token = "";
  let url = "";
  let boundHost = "";
  let boundPort = 0;
  let exposeMode = "";
  let passwordHash = null; // sha256 Buffer when a password is set
  const sessions = new Map(); // session id -> expiry epoch ms
  const loginFailures = new Map(); // remote address -> { count, resetAt }
  let options = {
    interactive: true,
    quality: DEFAULT_QUALITY,
    maxWidth: DEFAULT_MAX_DIMENSION,
  };

  const clients = new Set<any>();
  const rawSockets = new Set<any>();

  let activeId = null;
  let activePage = null;
  let activeCdp = null;
  let activeCloseListener = null;
  let streamingPromise = null;
  let lastMeta = null; // { deviceWidth, deviceHeight, url }
  let lastNavState = null; // { canGoBack, canGoForward } for the streamed page
  // Latest screencast frame, pre-encoded as a WebSocket frame: broadcast
  // serializes once for all viewers, and late joiners / tabs returning from
  // the background paint immediately instead of waiting for page damage.
  let lastFrameEncoded = null;
  let currentStreamWidth = 0;
  let viewportTimer = null;
  // Track the session's preferred (agent-current) page so we only auto-switch
  // when the agent changes focus — not when a human clicked a different tab
  // in the strip to inspect something in the background.
  let lastFollowedPreferredId = null;

  let agentState: "idle" | "driving" = "idle";
  let handoff = null; // { prompt, resolve, timer }
  let ask = null; // { question, options, resolve, timer }
  // Freeform human guidance queued for the agent harness (drained between turns).
  const humanInbox = [];
  // Ring buffer of chat lines for reconnecting viewers (agent steps + human).
  const chatHistory = [];
  let chatSeq = 0;
  const CHAT_HISTORY_LIMIT = 100;
  const HUMAN_INBOX_LIMIT = 50;
  const MAX_CHAT_TEXT = 4_000;

  let heartbeatTimer = null;
  let tabsTimer = null;
  let lastTabsJson = "";

  // One lightweight CDP session per background tab, kept while viewers are
  // connected, so the tab strip can preview pages other than the streamed one.
  // Each preview is captured once at native scale and displayed small by the
  // viewer; scaled CDP captures can corrupt a later live screencast's surface.
  const thumbSessions = new Map(); // pageId -> { page, cdp }
  const thumbCache = new Map(); // pageId -> data URL

  function tokenOk(candidate) {
    if (!token || !isString(candidate) || !candidate) return false;
    const a = crypto.createHash("sha256").update(candidate).digest();
    const b = crypto.createHash("sha256").update(token).digest();
    return crypto.timingSafeEqual(a, b);
  }

  function passwordOk(candidate) {
    if (!passwordHash || !isString(candidate) || !candidate) return false;
    const digest = crypto.createHash("sha256").update(candidate).digest();
    return crypto.timingSafeEqual(digest, passwordHash);
  }

  function sessionIdOf(request) {
    const header = String(request.headers.cookie || "");
    for (const part of header.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
    }
    return "";
  }

  function sessionOk(request) {
    if (!passwordHash) return true; // no password: the token is the only gate
    const id = sessionIdOf(request);
    if (!id) return false;
    const expires = sessions.get(id);
    if (!expires) return false;
    if (expires < Date.now()) {
      sessions.delete(id);
      return false;
    }
    return true;
  }

  function createSession() {
    // Bounded: evict the oldest sessions rather than growing unboundedly.
    while (sessions.size >= SESSION_LIMIT) {
      sessions.delete(sessions.keys().next().value);
    }
    const id = crypto.randomBytes(24).toString("base64url");
    sessions.set(id, Date.now() + SESSION_TTL_MS);
    return id;
  }

  function loginBlocked(address) {
    const entry = loginFailures.get(address);
    if (!entry) return false;
    if (entry.resetAt < Date.now()) {
      loginFailures.delete(address);
      return false;
    }
    return entry.count >= LOGIN_MAX_FAILURES;
  }

  function registerLoginFailure(address) {
    // Bounded map: an attacker cycling source addresses cannot balloon memory.
    if (loginFailures.size >= 1_000 && !loginFailures.has(address)) {
      for (const [key, entry] of loginFailures) {
        if (entry.resetAt < Date.now()) loginFailures.delete(key);
      }
      if (loginFailures.size >= 1_000) {
        loginFailures.delete(loginFailures.keys().next().value);
      }
    }
    const entry = loginFailures.get(address) || {
      count: 0,
      resetAt: Date.now() + LOGIN_FAILURE_WINDOW_MS,
    };
    entry.count += 1;
    loginFailures.set(address, entry);
  }

  function originOk(request) {
    const origin = String(request.headers.origin || "").trim();
    if (!origin) return true; // non-browser client; the token is the gate
    try {
      return new URL(origin).host === String(request.headers.host || "");
    } catch {
      return false;
    }
  }

  function inputAllowed() {
    return Boolean(handoff) || options.interactive === true;
  }

  function viewerState() {
    return handoff ? "handoff" : agentState;
  }

  function broadcastText(message) {
    const encoded = JSON.stringify(message);
    for (const client of clients) client.sendText(encoded);
  }

  function askState() {
    return ask
      ? { active: true, question: ask.question, options: ask.options }
      : { active: false };
  }

  function handoffState() {
    return handoff
      ? { active: true, prompt: handoff.prompt }
      : { active: false };
  }

  function broadcastState() {
    broadcastText({
      t: "state",
      agent: viewerState(),
      interactive: inputAllowed(),
      handoff: handoffState(),
      ask: askState(),
    });
  }

  function clipChatText(text) {
    return String(text || "").trim().slice(0, MAX_CHAT_TEXT);
  }

  function appendChat(entry) {
    const message = {
      id: ++chatSeq,
      role: entry.role === "you" || entry.role === "system" ? entry.role : "agent",
      text: clipChatText(entry.text),
      kind: entry.kind ? String(entry.kind).slice(0, 40) : undefined,
      at: Date.now(),
    };
    if (!message.text) return null;
    chatHistory.push(message);
    while (chatHistory.length > CHAT_HISTORY_LIMIT) chatHistory.shift();
    broadcastText({ t: "chat", message });
    return message;
  }

  function queueHumanMessage(text) {
    const trimmed = clipChatText(text);
    if (!trimmed) return null;
    // Answering a pending ask consumes the text instead of queuing guidance.
    if (ask) {
      resolveAsk("answer", trimmed);
      return appendChat({ role: "you", text: trimmed, kind: "answer" });
    }
    while (humanInbox.length >= HUMAN_INBOX_LIMIT) humanInbox.shift();
    humanInbox.push({ text: trimmed, at: Date.now() });
    return appendChat({ role: "you", text: trimmed, kind: "chat" });
  }

  function drainHumanMessages() {
    const messages = humanInbox.splice(0, humanInbox.length);
    return messages;
  }

  function postChat({ role = "agent", text = "", kind }: any = {}) {
    return appendChat({ role, text, kind });
  }

  function broadcastMeta() {
    if (!lastMeta) return;
    broadcastText({
      t: "meta",
      pageId: activeId,
      url: lastMeta.url || "",
      deviceWidth: lastMeta.deviceWidth,
      deviceHeight: lastMeta.deviceHeight,
    });
  }

  /**
   * Push back/forward availability for the streamed page so the viewer's nav
   * buttons reflect real history. Best-effort and change-deduplicated: called
   * on every URL change, attach, and connect.
   */
  async function refreshNavState(force = false) {
    const cdp = activeCdp;
    if (!cdp || !running) return;
    let state = { canGoBack: false, canGoForward: false };
    try {
      const history = await cdp.send("Page.getNavigationHistory");
      if (cdp !== activeCdp) return; // stream moved while we asked
      const entries = Array.isArray(history?.entries) ? history.entries : [];
      const index = Math.round(finiteNumber(history?.currentIndex, -1));
      state = {
        canGoBack: index > 0,
        canGoForward: index >= 0 && index < entries.length - 1,
      };
    } catch {
      /* history unavailable (page mid-navigation); keep defaults */
    }
    if (
      force ||
      !lastNavState ||
      state.canGoBack !== lastNavState.canGoBack ||
      state.canGoForward !== lastNavState.canGoForward
    ) {
      lastNavState = state;
      broadcastText({ t: "navstate", ...state });
    }
  }

  function withTimeout(promise, ms): Promise<any> {
    // The timer stays referenced so the cap fires even on an otherwise-empty
    // event loop (a wedged CDP transport during shutdown), and is cleared as
    // soon as the promise settles.
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out")), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async function dropThumbSession(id) {
    const holder = thumbSessions.get(id);
    thumbSessions.delete(id);
    thumbCache.delete(id);
    if (holder?.cdp) {
      try {
        await holder.cdp.detach?.();
      } catch {
        /* session already detached */
      }
    }
  }

  async function dropAllThumbs() {
    const ids = [...thumbSessions.keys()];
    thumbCache.clear();
    for (const id of ids) await dropThumbSession(id);
  }

  async function captureThumb(cdp) {
    const metrics = await cdp.send("Page.getLayoutMetrics");
    const viewport = metrics?.cssLayoutViewport || {};
    const width = finiteNumber(viewport.clientWidth, 0);
    const height = finiteNumber(viewport.clientHeight, 0);
    if (width < 1 || height < 1) return "";
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: THUMB_QUALITY,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    const data = String(shot?.data || "");
    return data ? `data:image/jpeg;base64,${data}` : "";
  }

  async function thumbFor(entry) {
    const cached = thumbCache.get(entry.id);
    if (cached) return cached;
    let holder = thumbSessions.get(entry.id);
    if (holder && holder.page !== entry.page) {
      await dropThumbSession(entry.id);
      holder = null;
    }
    if (!holder) {
      try {
        holder = { page: entry.page, cdp: await newCDPSession(entry.page) };
        thumbSessions.set(entry.id, holder);
      } catch {
        return thumbCache.get(entry.id) || "";
      }
    }
    try {
      const thumb = await withTimeout(captureThumb(holder.cdp), THUMB_TIMEOUT_MS);
      // The tab may have become active while capture was in flight. Only cache
      // a result from the still-current background session.
      if (
        thumb &&
        entry.id !== activeId &&
        thumbSessions.get(entry.id) === holder
      ) {
        thumbCache.set(entry.id, thumb);
      }
    } catch {
      /* keep the last good thumbnail */
    }
    return thumbCache.get(entry.id) || "";
  }

  function tabsSnapshot(entries) {
    return Promise.all(
      entries.map(async (entry) => {
        let title = "";
        try {
          title = await Promise.race([
            Promise.resolve(entry.page.title()),
            new Promise((resolve) => {
              const timer = setTimeout(() => resolve(""), TITLE_TIMEOUT_MS);
              timer.unref?.();
            }),
          ]);
        } catch {
          title = "";
        }
        let pageUrl = "";
        try {
          pageUrl = String(entry.page.url() || "");
        } catch {
          pageUrl = "";
        }
        return {
          id: entry.id,
          sessionId: entry.sessionId,
          url: pageUrl,
          title: String(title || ""),
          streaming: entry.id === activeId,
        };
      }),
    );
  }

  async function refreshTabs(force = false) {
    if (!running || clients.size === 0) return;
    const entries = listPages();
    const tabs = await tabsSnapshot(entries);
    const live = new Set(tabs.map((tab) => tab.id));
    for (const id of [...thumbSessions.keys()]) {
      if (!live.has(id)) void dropThumbSession(id).catch(() => {});
    }
    // The tab list itself is tiny (no pixels) and only rebroadcast on change;
    // thumbnails travel as separate per-tab deltas below, so an animating
    // background tab no longer re-sends every thumbnail every refresh.
    const encoded = JSON.stringify(tabs);
    if (force || encoded !== lastTabsJson) {
      lastTabsJson = encoded;
      broadcastText({ t: "tabs", tabs });
    }
    // Previews only matter once there is more than one tab to pick from, and
    // never for the streamed tab.
    if (entries.length > 1) {
      await Promise.all(
        entries
          .filter((entry) => entry.id !== activeId && live.has(entry.id))
          .map(async (entry) => {
            const previous = thumbCache.get(entry.id) || "";
            const thumb = await thumbFor(entry);
            if (entry.id !== activeId && thumb && thumb !== previous) {
              broadcastText({ t: "thumb", id: entry.id, thumb });
            }
          }),
      );
    }
  }

  async function teardownSession({ cdp, page, closeListener }) {
    if (page && closeListener) {
      try {
        page.off?.("close", closeListener);
      } catch {
        /* page already gone */
      }
    }
    if (cdp) {
      try {
        await cdp.send("Page.stopScreencast");
      } catch {
        /* session already detached */
      }
      try {
        await cdp.detach?.();
      } catch {
        /* session already detached */
      }
    }
  }

  async function detachActive() {
    const previous = {
      cdp: activeCdp,
      page: activePage,
      closeListener: activeCloseListener,
    };
    activeCdp = null;
    activePage = null;
    activeId = null;
    activeCloseListener = null;
    lastFrameEncoded = null;
    lastNavState = null;
    currentStreamWidth = 0;
    await teardownSession(previous);
  }

  // Every frame delivery goes through here so one rule can hold everywhere:
  // a client never receives the same encoded frame twice. Three paths can
  // otherwise race to resend the latest frame — the broadcast, the repaint a
  // viewer gets when its tab becomes visible again, and the instant first
  // paint on connect — and two of them firing for one frame is just a wasted
  // repaint. Identity comparison is deliberate: a genuinely new frame is a
  // new buffer even when its pixels are identical.
  function sendFrame(client, encoded) {
    if (client.lastFrameSent === encoded) return;
    if (client.bufferedAmount >= BACKPRESSURE_LIMIT) return;
    client.lastFrameSent = encoded;
    client.sendRaw(encoded);
  }

  function deliverFrame(encoded, meta) {
    if (
      !lastMeta ||
      meta.deviceWidth !== lastMeta.deviceWidth ||
      meta.deviceHeight !== lastMeta.deviceHeight ||
      meta.url !== lastMeta.url
    ) {
      const urlChanged = meta.url !== lastMeta?.url;
      lastMeta = meta;
      broadcastMeta();
      if (urlChanged) void refreshNavState().catch(() => {});
    }
    lastFrameEncoded = encoded;
    for (const client of clients) {
      if (client.viewerHidden) continue;
      sendFrame(client, encoded);
    }
  }

  function qualityValue() {
    return clamp(Math.round(finiteNumber(options.quality, DEFAULT_QUALITY)), 10, 90);
  }

  function effectiveMaxWidth() {
    const cap = clamp(
      Math.round(finiteNumber(options.maxWidth, DEFAULT_MAX_DIMENSION)),
      320,
      3840,
    );
    let want = 0;
    for (const client of clients) {
      const px = finiteNumber(client.viewportPx, 0);
      if (px > want) want = px;
    }
    if (want < 1) return cap; // no viewer reported a size: configured cap
    return clamp(Math.ceil(want / VIEWPORT_BUCKET_PX) * VIEWPORT_BUCKET_PX, 320, cap);
  }

  async function restartScreencast() {
    const cdp = activeCdp;
    if (!cdp || !running) return;
    const dimension = effectiveMaxWidth();
    if (dimension === currentStreamWidth) return;
    try {
      await cdp.send("Page.stopScreencast");
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: qualityValue(),
        maxWidth: dimension,
        maxHeight: dimension,
        everyNthFrame: 1,
      });
      currentStreamWidth = dimension;
    } catch (error) {
      log(`live-view: screencast resize failed: ${error?.message || error}`);
    }
  }

  function scheduleViewportApply() {
    clearTimeout(viewportTimer);
    viewportTimer = setTimeout(() => {
      viewportTimer = null;
      if (!running || !activeCdp) return;
      if (effectiveMaxWidth() === currentStreamWidth) return;
      streamingPromise = (streamingPromise || Promise.resolve()).then(
        restartScreencast,
        restartScreencast,
      );
    }, VIEWPORT_APPLY_DEBOUNCE_MS);
    viewportTimer.unref?.();
  }

  function pickPage(requestedId = null) {
    const entries = listPages();
    if (requestedId) {
      const match = entries.find((entry) => entry.id === requestedId);
      if (match) return match;
    }
    const preferred = preferredPage();
    if (preferred) {
      const match = entries.find((entry) => entry.page === preferred);
      if (match) return match;
    }
    return entries.find((entry) => entry.active) || entries[0] || null;
  }

  /**
   * Resolve the page the agent currently considers active (preferredPage /
   * active flag). Returns null when no pages are open.
   */
  function preferredEntry() {
    return pickPage(null);
  }

  /**
   * When the agent's current tab changes (openPage, usePage, popup, close),
   * stream that tab. Leaves a human-selected strip tab alone until preferred
   * actually moves — so inspecting a background tab is not yanked away every
   * refresh tick.
   */
  function followPreferred() {
    if (!running || clients.size === 0) return Promise.resolve();
    const entry = preferredEntry();
    const preferredId = entry?.id || null;
    if (preferredId === lastFollowedPreferredId) return Promise.resolve();
    if (!preferredId) {
      lastFollowedPreferredId = null;
      return refreshTabs(true);
    }
    if (preferredId === activeId) {
      // Already streaming it (e.g. human clicked the same tab the agent just
      // selected); mark followed so we do not thrash.
      lastFollowedPreferredId = preferredId;
      return refreshTabs(true);
    }
    // ensureStreaming / switchToPage updates lastFollowedPreferredId only
    // after attach succeeds, so a failed CDP attach can retry next tick.
    return ensureStreaming(preferredId);
  }

  async function attachTo(entry) {
    if (!entry) {
      await detachActive();
      return;
    }
    const { id, page } = entry;
    let cdp;
    try {
      cdp = await newCDPSession(page);
    } catch (error) {
      log(`live-view: screencast attach failed: ${error?.message || error}`);
      return;
    }
    // Make-before-break: the old screencast keeps painting until this session
    // produced its params and became active, so a tab switch never shows a
    // dead canvas. Frames that race ahead of the swap are stashed and flushed
    // the moment the swap lands.
    let pendingFrame = null;
    cdp.on("Page.screencastFrame", (event) => {
      // Ack immediately so Chromium keeps producing frames; flow control is
      // per-socket latest-frame-wins below, never a stalled ack.
      void Promise.resolve(
        cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }),
      ).catch(() => {});
      const frame = Buffer.from(String(event.data || ""), "base64");
      const metadata = event.metadata || {};
      let pageUrl = "";
      try {
        pageUrl = String(page.url() || "");
      } catch {
        pageUrl = "";
      }
      const meta = {
        deviceWidth: finiteNumber(metadata.deviceWidth, lastMeta?.deviceWidth || 0),
        deviceHeight: finiteNumber(metadata.deviceHeight, lastMeta?.deviceHeight || 0),
        url: pageUrl,
      };
      const encoded = encodeBinaryFrame(frame);
      if (cdp !== activeCdp) {
        pendingFrame = { encoded, meta };
        return;
      }
      deliverFrame(encoded, meta);
    });
    const closeListener = () => {
      if (activePage !== page) return;
      void switchToPage(null).catch(() => {});
      void refreshTabs(true).catch(() => {});
    };
    try {
      page.on?.("close", closeListener);
    } catch {
      /* fake pages without listeners are fine */
    }
    const dimension = effectiveMaxWidth();
    try {
      await cdp.send("Page.startScreencast", {
        format: "jpeg",
        quality: qualityValue(),
        maxWidth: dimension,
        maxHeight: dimension,
        everyNthFrame: 1,
      });
    } catch (error) {
      log(`live-view: startScreencast failed: ${error?.message || error}`);
      // The previous stream (if any) is still live; keep it.
      await teardownSession({ cdp, page, closeListener });
      return;
    }
    const previous = {
      cdp: activeCdp,
      page: activePage,
      closeListener: activeCloseListener,
    };
    activeId = id;
    activePage = page;
    activeCdp = cdp;
    activeCloseListener = closeListener;
    currentStreamWidth = dimension;
    lastFrameEncoded = null;
    if (pendingFrame) {
      deliverFrame(pendingFrame.encoded, pendingFrame.meta);
      pendingFrame = null;
    }
    // Time-capped so a wedged old session can never wedge tab switching.
    await withTimeout(teardownSession(previous), STOP_TEARDOWN_TIMEOUT_MS).catch(
      () => {},
    );
    // The preview is stale once its tab becomes live. Drop its background CDP
    // session and cache so a fresh preview is taken if it later goes inactive.
    if (thumbSessions.has(id) || thumbCache.has(id)) {
      await withTimeout(dropThumbSession(id), THUMB_TIMEOUT_MS).catch(() => {});
    }
  }

  async function switchToPage(requestedId) {
    const entry = pickPage(requestedId);
    if (entry && entry.id === activeId) {
      // Already there — keep follow-tracking in sync for preferred attaches.
      if (requestedId == null || preferredEntry()?.id === activeId) {
        lastFollowedPreferredId = activeId;
      }
      return;
    }
    await attachTo(entry);
    // Only mark followed once the screencast actually landed on this page
    // (attachTo no-ops activeId on CDP failure so a later tick can retry).
    if (activeId && (requestedId == null || preferredEntry()?.id === activeId)) {
      lastFollowedPreferredId = activeId;
    } else if (!entry) {
      lastFollowedPreferredId = null;
    }
    broadcastMeta();
    void refreshNavState(true).catch(() => {});
    await refreshTabs(true);
  }

  function ensureStreaming(requestedId = null) {
    // Serialize attach/detach so a burst of connects or tab switches cannot
    // interleave two CDP screencast sessions on the same server.
    streamingPromise = (streamingPromise || Promise.resolve()).then(
      () => switchToPage(requestedId),
      () => switchToPage(requestedId),
    );
    return streamingPromise;
  }

  async function dispatchInput(message) {
    const cdp = activeCdp;
    const page = activePage;
    if (!cdp || !page) return;
    const kind = String(message.kind || "");
    const modifiers = clamp(Math.round(finiteNumber(message.modifiers, 0)), 0, 15);
    if (kind === "mouse") {
      const type = String(message.type || "");
      if (!MOUSE_EVENT_TYPES.has(type)) return;
      const button = MOUSE_BUTTONS.has(message.button) ? message.button : "none";
      const params: MouseEventParams = {
        type,
        x: clamp(finiteNumber(message.x), 0, 100_000),
        y: clamp(finiteNumber(message.y), 0, 100_000),
        button,
        buttons: clamp(Math.round(finiteNumber(message.buttons, 0)), 0, 31),
        clickCount: clamp(Math.round(finiteNumber(message.clickCount, 0)), 0, 8),
        modifiers,
      };
      if (type === "mouseWheel") {
        params.deltaX = clamp(finiteNumber(message.deltaX), -4000, 4000);
        params.deltaY = clamp(finiteNumber(message.deltaY), -4000, 4000);
      }
      await cdp.send("Input.dispatchMouseEvent", params);
    } else if (kind === "key") {
      const type = String(message.type || "");
      if (!KEY_EVENT_TYPES.has(type)) return;
      const params: KeyEventParams = {
        type,
        modifiers,
        key: String(message.key || "").slice(0, 32),
        code: String(message.code || "").slice(0, 48),
      };
      const keyCode = Math.round(finiteNumber(message.keyCode, 0));
      if (keyCode > 0 && keyCode < 256) {
        params.windowsVirtualKeyCode = keyCode;
        params.nativeVirtualKeyCode = keyCode;
      }
      const text = String(message.text || "");
      if (text && text.length <= 8) params.text = text;
      await cdp.send("Input.dispatchKeyEvent", params);
    } else if (kind === "insertText") {
      const text = String(message.text || "").slice(0, 8_192);
      if (!text) return;
      await cdp.send("Input.insertText", { text });
    } else {
      return;
    }
    try {
      onHumanActivity(page);
    } catch {
      /* activity accounting must never break input */
    }
  }

  function stampHumanActivity(page) {
    try {
      onHumanActivity(page);
    } catch {
      /* activity accounting must never break navigation */
    }
  }

  // A tab switch is dispatched without being awaited, so a nav or navigate
  // arriving right behind one would otherwise read activeCdp before
  // switchToPage has moved it and drive the tab the human just left. Settle
  // the in-flight switch first; a failed switch still leaves a usable target.
  async function settledTarget() {
    try {
      await streamingPromise;
    } catch {
      /* the switch failed; fall through to whatever is streaming now */
    }
    return { cdp: activeCdp, page: activePage };
  }

  // Toolbar navigation on the streamed page: back / forward / reload through
  // CDP history, so the viewer behaves like the page's own browser chrome.
  async function dispatchNav(message) {
    const { cdp, page } = await settledTarget();
    if (!cdp || !page) return;
    const action = String(message.action || "");
    if (action === "reload") {
      await cdp.send("Page.reload");
    } else if (action === "stop") {
      await cdp.send("Page.stopLoading");
    } else if (action === "back" || action === "forward") {
      const history = await cdp.send("Page.getNavigationHistory");
      if (cdp !== activeCdp) return;
      const entries = Array.isArray(history?.entries) ? history.entries : [];
      const index = Math.round(finiteNumber(history?.currentIndex, -1));
      const target = entries[index + (action === "back" ? -1 : 1)];
      if (!target) return;
      await cdp.send("Page.navigateToHistoryEntry", { entryId: target.id });
    } else {
      return;
    }
    stampHumanActivity(page);
    void refreshNavState(true).catch(() => {});
  }

  async function dispatchNavigate(client, message) {
    const { cdp, page } = await settledTarget();
    if (!cdp || !page) return;
    const url = normalizeViewerUrl(message.url);
    if (!url) {
      client.sendText(
        JSON.stringify({ t: "toast", text: "Only http(s) addresses can be opened here." }),
      );
      return;
    }
    await cdp.send("Page.navigate", { url });
    stampHumanActivity(page);
  }

  async function dispatchNewTab(client, message) {
    if (!isTabOpener(openPage)) {
      client.sendText(
        JSON.stringify({ t: "toast", text: "This live view cannot open new tabs." }),
      );
      return;
    }
    let page;
    try {
      page = await openPage();
    } catch (error) {
      client.sendText(
        JSON.stringify({
          t: "toast",
          text: `Could not open a tab: ${String(error?.message || error).slice(0, 200)}`,
        }),
      );
      return;
    }
    // The worker may refuse (page limit) by handing back an already-closed page.
    if (!page || page.isClosed?.()) {
      client.sendText(
        JSON.stringify({ t: "toast", text: "Could not open a tab (page limit reached)." }),
      );
      return;
    }
    stampHumanActivity(page);
    const entry = listPages().find((candidate) => candidate.page === page);
    if (entry) await ensureStreaming(entry.id);
    const url = normalizeViewerUrl(message.url);
    if (url && url !== "about:blank" && activeCdp && activePage === page) {
      await activeCdp.send("Page.navigate", { url });
    }
  }

  async function dispatchCloseTab(message) {
    const id = String(message.id || "");
    if (!id) return;
    const entry = listPages().find((candidate) => candidate.id === id);
    if (!entry) return;
    stampHumanActivity(entry.page);
    try {
      await entry.page.close?.();
    } catch {
      /* already closing */
    }
    await refreshTabs(true);
  }

  function resolveHandoff(action, note) {
    const pending = handoff;
    if (!pending) return;
    handoff = null;
    clearTimeout(pending.timer);
    broadcastState();
    pending.resolve({
      action,
      note: String(note || "").slice(0, MAX_CHAT_TEXT),
    });
  }

  function resolveAsk(action, answer) {
    const pending = ask;
    if (!pending) return;
    ask = null;
    clearTimeout(pending.timer);
    broadcastState();
    pending.resolve({
      action,
      answer: String(answer || "").slice(0, MAX_CHAT_TEXT),
    });
  }

  function handleClientMessage(client, raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const type = String(message?.t || "");
    const drives =
      type === "input" ||
      type === "tab" ||
      type === "nav" ||
      type === "navigate" ||
      type === "newtab" ||
      type === "closetab";
    if (drives) {
      // Everything that steers the browser — input, tab switching, toolbar
      // navigation, opening and closing tabs — sits behind the same gate.
      if (!inputAllowed()) {
        client.sendText(
          JSON.stringify({ t: "toast", text: "This live view is watch-only." }),
        );
        return;
      }
      const failLogged = (label) => (error) => {
        log(`live-view: ${label} failed: ${error?.message || error}`);
      };
      if (type === "tab") {
        void ensureStreaming(String(message.id || "")).catch(() => {});
      } else if (type === "nav") {
        void dispatchNav(message).catch(failLogged("nav"));
      } else if (type === "navigate") {
        void dispatchNavigate(client, message).catch(failLogged("navigate"));
      } else if (type === "newtab") {
        void dispatchNewTab(client, message).catch(failLogged("new tab"));
      } else if (type === "closetab") {
        void dispatchCloseTab(message).catch(failLogged("close tab"));
      } else {
        void dispatchInput(message).catch(failLogged("input dispatch"));
      }
      return;
    }
    if (type === "chat" || type === "answer") {
      // Chat is always allowed: watch-only only blocks browser input, not talk.
      queueHumanMessage(message.text ?? message.note ?? "");
      return;
    }
    if (type === "done" || type === "cancel") {
      if (!handoff) return;
      // Optional note also becomes a chat line so the transcript stays complete.
      const note = clipChatText(message.note);
      if (note) appendChat({ role: "you", text: note, kind: type });
      resolveHandoff(type, note);
      return;
    }
    if (type === "vis") {
      // A hidden viewer tab drops frames on the floor anyway; stop paying to
      // send them. On return it repaints from the latest frame immediately.
      client.viewerHidden = message.hidden === true;
      if (!client.viewerHidden && lastFrameEncoded) {
        sendFrame(client, lastFrameEncoded);
      }
      return;
    }
    if (type === "view") {
      // Largest wanted dimension in device pixels; the screencast is capped to
      // the biggest connected viewer so small windows stream small frames.
      client.viewportPx = clamp(Math.round(finiteNumber(message.px, 0)), 0, 8_192);
      scheduleViewportApply();
      return;
    }
    if (type === "refresh") {
      void refreshNavState(true).catch(() => {});
      void refreshTabs(true).catch(() => {});
    }
  }

  function handleConnection(connection) {
    const client = connection;
    client.isAlive = true;
    client.onPong = () => {
      client.isAlive = true;
    };
    clients.add(client);
    client.onMessage = ({ type, data }) => {
      if (type !== "text") return;
      handleClientMessage(client, data);
    };
    client.onClose = () => {
      clients.delete(client);
      if (clients.size === 0) {
        // No viewers: stop burning CPU on screencast frames and thumbnails.
        // The server (and any pending handoff) stays up for the next connect.
        streamingPromise = (streamingPromise || Promise.resolve()).then(
          () => detachActive().then(() => dropAllThumbs()),
          () => detachActive().then(() => dropAllThumbs()),
        );
      } else {
        // The departed viewer may have been the largest window; shrink to fit.
        scheduleViewportApply();
      }
    };
    client.sendText(
      JSON.stringify({
        t: "hello",
        agent: viewerState(),
        interactive: inputAllowed(),
        handoff: handoffState(),
        ask: askState(),
        caps: { newTab: isCallable(openPage) },
      }),
    );
    if (lastNavState) {
      client.sendText(JSON.stringify({ t: "navstate", ...lastNavState }));
    }
    if (chatHistory.length) {
      client.sendText(JSON.stringify({ t: "chat", messages: chatHistory.slice() }));
    }
    // Instant first paint: replay cached thumbnails and the latest frame so
    // the viewer is never a black canvas waiting for the next page damage.
    for (const [id, thumb] of thumbCache) {
      client.sendText(JSON.stringify({ t: "thumb", id, thumb }));
    }
    if (lastFrameEncoded) sendFrame(client, lastFrameEncoded);
    void ensureStreaming()
      .then(() => {
        broadcastMeta();
        void refreshNavState(true).catch(() => {});
        return refreshTabs(true);
      })
      .catch(() => {});
  }

  function servePage(response, markup, extraHeaders: any = {}) {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      ...extraHeaders,
    });
    response.end(markup);
  }

  function handleLogin(request, response, requestUrl) {
    const address = String(request.socket?.remoteAddress || "unknown");
    if (loginBlocked(address)) {
      response.writeHead(429, { "content-type": "text/plain; charset=utf-8" });
      response.end("Too many attempts. Try again later.");
      return;
    }
    let body = "";
    let overflow = false;
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > LOGIN_BODY_LIMIT) {
        overflow = true;
        request.destroy();
      }
    });
    request.on("end", () => {
      if (overflow) return;
      const password = new URLSearchParams(body).get("password") || "";
      const back = `/?t=${encodeURIComponent(requestUrl.searchParams.get("t") || "")}`;
      if (!passwordOk(password)) {
        registerLoginFailure(address);
        response.writeHead(303, { location: `${back}&auth=failed` });
        response.end();
        return;
      }
      loginFailures.delete(address);
      const id = createSession();
      response.writeHead(303, {
        location: back,
        // HttpOnly + SameSite=Strict: the id never reaches page script and is
        // not sent on cross-site requests. (Served over http on LAN/tailnet,
        // so no Secure flag — the tailnet/tunnel provides transport security.)
        "set-cookie": `${SESSION_COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1_000)}`,
      });
      response.end();
    });
  }

  function handleRequest(request, response) {
    const requestUrl = new URL(String(request.url || "/"), "http://localhost");
    const deny = () => {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    };
    // The capability token gates everything, including the login endpoint.
    if (!tokenOk(requestUrl.searchParams.get("t"))) return deny();
    if (request.method === "POST" && requestUrl.pathname === "/login" && passwordHash) {
      return handleLogin(request, response, requestUrl);
    }
    if (request.method !== "GET" || requestUrl.pathname !== "/") return deny();
    if (!sessionOk(request)) return servePage(response, loginHtml());
    return servePage(response, html());
  }

  function handleUpgrade(request, socket) {
    const requestUrl = new URL(String(request.url || "/"), "http://localhost");
    if (
      requestUrl.pathname !== "/ws" ||
      !tokenOk(requestUrl.searchParams.get("t")) ||
      !sessionOk(request) ||
      !originOk(request) ||
      !isWebSocketUpgrade(request)
    ) {
      socket.destroy();
      return;
    }
    const connection = upgradeWebSocket(request, socket);
    if (connection) handleConnection(connection);
  }

  async function start(startOptions: any = {}) {
    if (running) {
      // Idempotent: a second start returns the live URL instead of rotating
      // the token out from under an open viewer.
      return { ...status(), alreadyRunning: true };
    }
    const defaults = defaultLiveViewListen();
    // Expose presets keep hosting a one-word choice; an explicit preset wins
    // over host/publicHost so `expose: "tailscale"` composes with defaults.
    const expose = String(startOptions.expose || "").trim().toLowerCase();
    if (!EXPOSE_MODES.has(expose)) {
      throw new Error(
        `Unknown live-view expose mode "${expose}" — use "lan", "local", or "tailscale".`,
      );
    }
    let host = String(startOptions.host || defaults.host);
    let publicHostOverride = startOptions.publicHost;
    if (expose === "local") {
      host = "127.0.0.1";
      publicHostOverride = "127.0.0.1";
    } else if (expose === "tailscale") {
      const tailnet = guessTailscaleHost();
      if (!tailnet) {
        throw new Error(
          "No Tailscale address found on this machine (no 100.64.0.0/10 interface). " +
            "Start Tailscale first, or use --expose lan / --expose local.",
        );
      }
      host = tailnet;
      publicHostOverride = tailnet;
    } else if (expose === "lan") {
      host = defaults.host;
      publicHostOverride = startOptions.publicHost || defaults.publicHost;
    }
    exposeMode = expose || (host === "127.0.0.1" ? "local" : "lan");
    // Password gate: either a plaintext password (library callers, env) or a
    // stored "sha256:<hex>" digest from the config file — never both needed.
    const password = isString(startOptions.password) ? startOptions.password : "";
    const storedHash = isString(startOptions.passwordHash)
      ? startOptions.passwordHash.trim()
      : "";
    if (password && password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(
        `The live-view password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
    }
    if (storedHash && !/^(sha256:)?[0-9a-f]{64}$/i.test(storedHash)) {
      throw new Error(
        'Invalid live-view passwordHash — expected "sha256:<64 hex chars>" ' +
          "(set it with `betterwright view --set-password`).",
      );
    }
    passwordHash = password
      ? crypto.createHash("sha256").update(password).digest()
      : storedHash
        ? Buffer.from(storedHash.replace(/^sha256:/i, ""), "hex")
        : null;
    const port = clamp(Math.round(finiteNumber(startOptions.port, 0)), 0, 65_535);
    options = {
      interactive: startOptions.interactive !== false,
      quality: finiteNumber(startOptions.quality, DEFAULT_QUALITY),
      maxWidth: finiteNumber(startOptions.maxWidth, DEFAULT_MAX_DIMENSION),
    };
    // A trusted host may pin the token (and port) so a live view revived
    // after a worker restart keeps its original URL — viewers mid-reconnect
    // land back on the same link. Model-reachable surfaces (MCP handoff args)
    // never pass one; a fresh start still mints a random token.
    token =
      isString(startOptions.token) && /^[A-Za-z0-9_-]{16,128}$/.test(startOptions.token)
        ? startOptions.token
        : crypto.randomBytes(24).toString("base64url");
    server = http.createServer(handleRequest);
    server.on("upgrade", handleUpgrade);
    server.on("connection", (socket) => {
      rawSockets.add(socket);
      socket.on("close", () => rawSockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    const address = server.address();
    boundHost = host;
    boundPort = address?.port || port;
    const wildcard = host === "0.0.0.0" || host === "::" || host === "";
    const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
    // Always prefer a LAN address in the printed URL unless the bind is
    // deliberately loopback-only (or the caller set publicHost).
    const urlHost = loopback
      ? host === "::1"
        ? "[::1]"
        : "127.0.0.1"
      : wildcard
        ? String(publicHostOverride || defaults.publicHost || guessLanHost())
        : host.includes(":")
          ? `[${host}]`
          : host;
    url = `http://${urlHost}:${boundPort}/?t=${token}`;
    running = true;
    heartbeatTimer = setInterval(() => {
      for (const client of clients) {
        if (client.isAlive === false) {
          client.destroy();
          clients.delete(client);
          continue;
        }
        client.isAlive = false;
        client.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref?.();
    tabsTimer = setInterval(() => {
      // Prefer follow over a bare tab refresh: when the agent openPage/usePage
      // changes focus between ticks, the stream must move even if no one
      // called followPreferred() from the worker.
      void followPreferred()
        .then(() => refreshTabs())
        .catch(() => {});
    }, TABS_REFRESH_INTERVAL_MS);
    tabsTimer.unref?.();
    log(`live-view: listening on ${boundHost}:${boundPort}`);
    return status();
  }

  function status(): LiveViewStatus {
    const state: LiveViewStatus = { ok: true, running };
    if (running) {
      state.url = url;
      state.host = boundHost;
      state.port = boundPort;
      state.token = token;
      state.expose = exposeMode;
      state.passwordProtected = Boolean(passwordHash);
      state.interactive = options.interactive;
      state.viewers = clients.size;
      state.agent = viewerState();
      state.handoff = handoffState();
      state.ask = askState();
      state.pendingChat = humanInbox.length;
    }
    return state;
  }

  function beginHandoff(prompt, { timeoutMs }: any = {}) {
    if (!running) {
      return Promise.reject(new Error("Live view is not running."));
    }
    if (handoff) {
      return Promise.reject(new Error("A handoff is already in progress."));
    }
    const promptText = String(prompt || "").slice(0, 2_000);
    appendChat({
      role: "agent",
      text: promptText || "The agent needs your hands in the browser.",
      kind: "handoff",
    });
    return new Promise((resolve) => {
      const waitMs = finiteNumber(timeoutMs, 0);
      const timer =
        waitMs > 0
          ? setTimeout(() => resolveHandoff("timeout", ""), waitMs)
          : null;
      timer?.unref?.();
      handoff = { prompt: promptText, resolve, timer };
      broadcastState();
    });
  }

  function beginAsk(
    question,
    { options: choiceList = [], timeoutMs }: any = {},
  ) {
    if (!running) {
      return Promise.reject(new Error("Live view is not running."));
    }
    if (ask) {
      return Promise.reject(new Error("An ask is already in progress."));
    }
    const questionText = String(question || "").slice(0, 2_000);
    const options = (Array.isArray(choiceList) ? choiceList : [])
      .map((item) => String(item || "").trim().slice(0, 200))
      .filter(Boolean)
      .slice(0, 12);
    appendChat({
      role: "agent",
      text: questionText || "The agent has a question.",
      kind: "ask",
    });
    return new Promise((resolve) => {
      const waitMs = finiteNumber(timeoutMs, 0);
      const timer =
        waitMs > 0
          ? setTimeout(() => resolveAsk("timeout", ""), waitMs)
          : null;
      timer?.unref?.();
      ask = { question: questionText, options, resolve, timer };
      broadcastState();
    });
  }

  function setAgentState(state) {
    const next = state === "driving" ? "driving" : "idle";
    if (next === agentState) return;
    agentState = next;
    broadcastState();
  }

  async function stop({ notify = true }: any = {}) {
    if (!running && !server) return;
    running = false;
    resolveHandoff("cancel", "live view stopped");
    resolveAsk("cancel", "");
    humanInbox.length = 0;
    chatHistory.length = 0;
    clearInterval(heartbeatTimer);
    clearInterval(tabsTimer);
    clearTimeout(viewportTimer);
    heartbeatTimer = null;
    tabsTimer = null;
    viewportTimer = null;
    for (const client of clients) {
      try {
        // notify:false is the worker-teardown path: skip the terminal "bye"
        // so viewers drop into their reconnect loop — the host revives the
        // server on the same URL when the replacement worker comes up. A
        // deliberate stop still tells them the view is over.
        if (notify) client.sendText(JSON.stringify({ t: "bye", reason: "stopped" }));
        client.close(1001, "live view stopped");
      } catch {
        /* already gone */
      }
    }
    clients.clear();
    const closing = server;
    server = null;
    token = "";
    url = "";
    exposeMode = "";
    passwordHash = null;
    sessions.clear();
    loginFailures.clear();
    lastMeta = null;
    lastTabsJson = "";
    lastFollowedPreferredId = null;
    if (closing) {
      await new Promise<void>((resolve) => {
        closing.close(() => resolve());
        for (const socket of rawSockets) socket.destroy();
        rawSockets.clear();
      });
    }
    // The listener is gone; CDP teardown is best-effort and time-capped so a
    // dead browser can never keep the worker process alive.
    await withTimeout(detachActive(), STOP_TEARDOWN_TIMEOUT_MS).catch(() => {});
    await withTimeout(dropAllThumbs(), STOP_TEARDOWN_TIMEOUT_MS).catch(() => {});
  }

  return {
    start,
    stop,
    status,
    beginHandoff,
    beginAsk,
    postChat,
    drainHumanMessages,
    setAgentState,
    refreshTabs: () => refreshTabs(true),
    /** Stream the agent's current tab when it changed (openPage / usePage / popup). */
    followPreferred,
    get running() {
      return running;
    },
    get url() {
      return url;
    },
  };
}
