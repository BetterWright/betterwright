// Snippet-scoped page event listeners.
//
// Raw `page.on` stays forbidden: request/response objects leak headers and
// bodies, and `removeAllListeners` would strip the worker's own download,
// dialog, and site-request hooks. Models still need Playwright's usual
// `page.on("console")` / `page.on("pageerror")` pattern for CSP and smoke
// checks, so the worker owns one dispatcher per allowed event and only those
// two names are accepted. Listeners die with the snippet because they close
// over a discarded vm realm.

import {
  isCallable,
  isString,
  type UntrustedValue,
  untrustedField,
} from "./untrusted-value.js";

function isEventListener(
  value: UntrustedValue,
): value is (payload: UntrustedValue) => UntrustedValue {
  return typeof value === "function";
}

export const SNIPPET_PAGE_EVENTS = new Set(["console", "pageerror"]);
export const SNIPPET_PAGE_EVENT_METHODS = new Set([
  "addListener",
  "off",
  "on",
  "once",
  "removeListener",
]);
export const MAX_SNIPPET_PAGE_LISTENERS = 32;

const ALLOWED_EVENT_LIST = [...SNIPPET_PAGE_EVENTS].join(" and ");

export function isSnippetPageEventMethod(kind, property) {
  return kind === "Page" && isString(property) && SNIPPET_PAGE_EVENT_METHODS.has(property);
}

export function snippetPageEventError(property, event) {
  const received = isString(event) ? JSON.stringify(event) : "non-string";
  return new Error(
    `page.${property}() can only listen for ${ALLOWED_EVENT_LIST}. ` +
      "Request routing and other Playwright events stay inside the worker. " +
      `Received ${received}.`,
  );
}

function deliver(handler, payload) {
  try {
    const result = handler.listener(handler.adopt(payload));
    if (result && isCallable(untrustedField(result, "then"))) {
      result.then(undefined, () => {});
    }
  } catch {
    // A throwing snippet listener must not break the worker or sibling handlers.
  }
}

export function createSnippetPageEvents() {
  const pages = new Map();
  let total = 0;

  function uninstall(page, event, entry) {
    const eventMap = pages.get(page);
    if (eventMap?.get(event) === entry) eventMap.delete(event);
    if (eventMap && eventMap.size === 0) pages.delete(page);
    try {
      page.off(event, entry.raw);
    } catch {
      /* the page may already be closed */
    }
  }

  function detachListener(page, event, listener) {
    const entry = pages.get(page)?.get(event);
    if (!entry) return;
    const index = entry.handlers.findIndex((handler) => handler.listener === listener);
    if (index === -1) return;
    entry.handlers.splice(index, 1);
    total = Math.max(0, total - 1);
    if (entry.handlers.length === 0) uninstall(page, event, entry);
  }

  function attach(page, event, listener, once, adopt) {
    if (total >= MAX_SNIPPET_PAGE_LISTENERS) {
      throw new Error(
        `page event listener limit (${MAX_SNIPPET_PAGE_LISTENERS}) reached for this run.`,
      );
    }
    let eventMap = pages.get(page);
    if (!eventMap) {
      eventMap = new Map();
      pages.set(page, eventMap);
    }
    let entry = eventMap.get(event);
    if (!entry) {
      const created = {
        raw: (payload) => {
          for (const handler of [...created.handlers]) {
            if (handler.once) {
              const index = created.handlers.indexOf(handler);
              if (index !== -1) {
                created.handlers.splice(index, 1);
                total = Math.max(0, total - 1);
              }
            }
            deliver(handler, payload);
          }
          if (created.handlers.length === 0) uninstall(page, event, created);
        },
        handlers: [],
      };
      entry = created;
      page.on(event, created.raw);
      eventMap.set(event, created);
    }
    entry.handlers.push({ listener, once, adopt });
    total += 1;
  }

  function dispatch(page, method, event, listener, adopt) {
    if (!isString(event) || !SNIPPET_PAGE_EVENTS.has(event)) {
      throw snippetPageEventError(method, event);
    }
    if (!isEventListener(listener)) {
      throw new TypeError(`page.${method}() listener must be a function`);
    }
    if (method === "off" || method === "removeListener") {
      detachListener(page, event, listener);
      return;
    }
    attach(page, event, listener, method === "once", adopt);
  }

  function detachAll() {
    for (const [page, eventMap] of pages) {
      for (const [event, entry] of eventMap) {
        entry.handlers.length = 0;
        try {
          page.off(event, entry.raw);
        } catch {
          /* the page may already be closed */
        }
      }
    }
    pages.clear();
    total = 0;
  }

  return {
    dispatch,
    detachAll,
    get size() {
      return total;
    },
  };
}
