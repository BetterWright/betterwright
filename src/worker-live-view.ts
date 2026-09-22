import type { BrowserContext, Page } from "playwright-core";

import { createLiveViewServer } from "./live-view.js";
import { liveViewHtml, liveViewLoginHtml } from "./live-view-html.js";
import type { UntrustedValue } from "./untrusted-value.js";
import { isObjectValue, untrustedField } from "./untrusted-value.js";
import type { WorkerSession } from "./worker-session.js";

type LiveViewServer = ReturnType<typeof createLiveViewServer>;
type LiveViewStopOptions = Parameters<LiveViewServer["stop"]>[0];

type WorkerResult = {
  type: "result";
  id: UntrustedValue;
  [key: string]: UntrustedValue;
};

interface WorkerMessage {
  id: UntrustedValue;
  config?: UntrustedValue;
  options?: UntrustedValue;
  sessionId?: UntrustedValue;
  prompt?: UntrustedValue;
  question?: UntrustedValue;
  timeoutMs?: UntrustedValue;
  role?: UntrustedValue;
  text?: UntrustedValue;
  kind?: UntrustedValue;
}

interface WorkerLiveViewDeps {
  getBrowserContext: () => BrowserContext | null;
  sessions: ReadonlyMap<string, WorkerSession>;
  sessionFor: (id: UntrustedValue) => WorkerSession;
  pageOwner: (page: Page) => string | undefined;
  adoptPage: (page: Page, sessionId: string) => Page;
  wakeSessionPages: (session: WorkerSession) => Promise<void>;
  ensureBrowser: (config: UntrustedValue) => Promise<BrowserContext>;
  sendResult: (message: WorkerResult) => void;
  redactText: (value: UntrustedValue) => string;
  serverFactory?: typeof createLiveViewServer;
}

function currentBrowserContext(getBrowserContext: () => BrowserContext | null) {
  const browserContext = getBrowserContext();
  if (!browserContext) throw new Error("Browser context is not available.");
  return browserContext;
}

export function createWorkerLiveView({
  getBrowserContext,
  sessions,
  sessionFor,
  pageOwner,
  adoptPage,
  wakeSessionPages,
  ensureBrowser,
  sendResult,
  redactText,
  serverFactory = createLiveViewServer,
}: WorkerLiveViewDeps) {
  let liveView: LiveViewServer | null = null;
  let liveViewPreferredSession = "default";

  function liveViewPages() {
    const entries: Array<{
      id: string;
      page: Page;
      sessionId: string;
      active: boolean;
    }> = [];
    for (const [sessionId, session] of sessions) {
      for (const [id, page] of session.pages) {
        if (page.isClosed()) continue;
        entries.push({
          id,
          page,
          sessionId,
          active: session.currentId === id,
        });
      }
    }
    return entries;
  }

  /** Tell a running live view to stream the agent's current tab when it changed. */
  function notifyLiveViewPreferred() {
    try {
      liveView?.followPreferred?.();
    } catch {
      /* live view must never break page adoption */
    }
  }

  function ensureLiveView(preferredSessionId: UntrustedValue) {
    liveViewPreferredSession = String(preferredSessionId || "default");
    liveView ??= serverFactory({
      html: liveViewHtml,
      loginHtml: liveViewLoginHtml,
      listPages: liveViewPages,
      preferredPage: () => {
        const session = sessions.get(liveViewPreferredSession);
        const page = session?.currentId ? session.pages.get(session.currentId) : null;
        return page && !page.isClosed() ? page : null;
      },
      newCDPSession: (page: Page) => currentBrowserContext(getBrowserContext).newCDPSession(page),
      openPage: async () => {
        // A human's + button opens the tab in the viewed session, through the
        // same adoption path as agent pages. Page limits, listeners, policy,
        // and parking behavior all apply identically.
        const session = sessionFor(liveViewPreferredSession);
        const page = await currentBrowserContext(getBrowserContext).newPage();
        return adoptPage(page, session.id);
      },
      onHumanActivity: (page: Page) => {
        const sessionId = pageOwner(page);
        // Human input keeps the owning session warm exactly like model activity,
        // so the idle reaper never closes tabs under a person's hands.
        if (sessionId) sessionFor(sessionId);
      },
      log: (line: string) => process.stderr.write(`${line}\n`),
    });
    return liveView;
  }

  async function liveViewStart(message: WorkerMessage) {
    try {
      await ensureBrowser(message.config);
      const options = isObjectValue(message.options) ? message.options : {};
      const view = ensureLiveView(untrustedField(options, "session"));
      // A viewer is about to watch these pages, so nothing may stay parked: the
      // stream would show a still frame of a page whose script is switched off.
      // hasView() keeps them awake from here on while the instance is owned.
      for (const session of sessions.values()) await wakeSessionPages(session);
      const info = await view.start(options);
      sendResult({ type: "result", id: message.id, ...info });
    } catch (error) {
      sendResult({
        type: "result",
        id: message.id,
        ok: false,
        error: redactText(error?.message || String(error)),
      });
    }
  }

  async function stop(options?: LiveViewStopOptions) {
    const view = liveView;
    liveView = null;
    await view?.stop(options);
  }

  async function liveViewStop(message: WorkerMessage) {
    try {
      await stop();
      sendResult({ type: "result", id: message.id, ok: true, running: false });
    } catch (error) {
      sendResult({
        type: "result",
        id: message.id,
        ok: false,
        error: redactText(error?.message || String(error)),
      });
    }
  }

  function liveViewStatus(message: WorkerMessage) {
    const info = liveView ? liveView.status() : { ok: true, running: false };
    sendResult({ type: "result", id: message.id, ...info });
  }

  async function handoffWait(message: WorkerMessage) {
    const session = sessionFor(message.sessionId);
    try {
      if (!liveView?.running) {
        throw new Error("Live view is not running; start it before requesting a handoff.");
      }
      // The reaper hold used by the ask flow: pages stay alive for the whole
      // human turn even if it outlasts the idle timeout.
      session.awaitingAnswerSince = Date.now();
      const outcome = await liveView.beginHandoff(String(message.prompt || ""), {
        timeoutMs: Math.max(Number(message.timeoutMs) || 0, 1_000),
      });
      sendResult({
        type: "result",
        id: message.id,
        ok: true,
        action: untrustedField(outcome, "action"),
        note: redactText(untrustedField(outcome, "note") || ""),
      });
    } catch (error) {
      sendResult({
        type: "result",
        id: message.id,
        ok: false,
        error: redactText(error?.message || String(error)),
      });
    } finally {
      session.awaitingAnswerSince = null;
    }
  }

  async function askWait(message: WorkerMessage) {
    const session = sessionFor(message.sessionId);
    try {
      if (!liveView?.running) {
        throw new Error("Live view is not running; start it before requesting an ask.");
      }
      session.awaitingAnswerSince = Date.now();
      const options = Array.isArray(message.options) ? message.options : [];
      const outcome = await liveView.beginAsk(String(message.question || ""), {
        options,
        timeoutMs: Math.max(Number(message.timeoutMs) || 0, 1_000),
      });
      sendResult({
        type: "result",
        id: message.id,
        ok: true,
        action: untrustedField(outcome, "action"),
        answer: redactText(untrustedField(outcome, "answer") || ""),
      });
    } catch (error) {
      sendResult({
        type: "result",
        id: message.id,
        ok: false,
        error: redactText(error?.message || String(error)),
      });
    } finally {
      session.awaitingAnswerSince = null;
    }
  }

  function liveViewChatPost(message: WorkerMessage) {
    try {
      if (!liveView?.running) {
        sendResult({
          type: "result",
          id: message.id,
          ok: false,
          error: "Live view is not running.",
        });
        return;
      }
      const posted = liveView.postChat({
        role: String(message.role || "agent"),
        text: String(message.text || ""),
        kind: message.kind ? String(message.kind) : undefined,
      });
      sendResult({
        type: "result",
        id: message.id,
        ok: true,
        message: posted,
      });
    } catch (error) {
      sendResult({
        type: "result",
        id: message.id,
        ok: false,
        error: redactText(error?.message || String(error)),
      });
    }
  }

  function liveViewChatDrain(message: WorkerMessage) {
    try {
      const messages = liveView?.running ? liveView.drainHumanMessages() : [];
      sendResult({
        type: "result",
        id: message.id,
        ok: true,
        messages: messages.map((item) => ({
          text: redactText(item.text || ""),
          at: item.at,
        })),
      });
    } catch (error) {
      sendResult({
        type: "result",
        id: message.id,
        ok: false,
        error: redactText(error?.message || String(error)),
      });
    }
  }

  function setAgentState(state: "idle" | "driving") {
    liveView?.setAgentState(state);
  }

  function hasView() {
    return Boolean(liveView);
  }

  return {
    liveViewStart,
    liveViewStop,
    liveViewStatus,
    handoffWait,
    askWait,
    liveViewChatPost,
    liveViewChatDrain,
    notifyLiveViewPreferred,
    setAgentState,
    hasView,
    stop,
  };
}
