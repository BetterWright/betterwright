import fs from "node:fs";
import path from "node:path";
import { types as utilTypes } from "node:util";
import vm from "node:vm";
import type { Page } from "playwright-core";
import {
  isPublicSearchNavigation,
  PUBLIC_SEARCH_BLOCK_ADVICE,
} from "./challenges.js";
import {
  applyNavigationDefaults,
  navigateHistory,
} from "./navigation-defaults.js";
import {
  type createSnippetPageEvents,
  isSnippetPageEventMethod,
} from "./page-events.js";
import {
  isBoolean,
  isCallable,
  isNumber,
  isObjectValue,
  isString,
  type UntrustedValue,
  untrustedField,
} from "./untrusted-value.js";
import type { WorkerSession } from "./worker-session.js";

export interface WorkerRealmDependencies {
  artifactsDir: () => string;
  hostOwnedTarget: () => boolean;
  hostUploadFiles: () => readonly string[] | undefined;
  publicSearchPolicy: () => string | undefined;
  useSetContentCompatibility: () => boolean;
  stopPageRecording: (page: Page) => Promise<void>;
  redactText: (value: UntrustedValue) => string;
  redactDeep: <Value>(value: Value) => Value;
  pageId: (page: Page) => string;
  pageIds: WeakMap<object, string>;
  defaultNavigationTimeoutMs: number;
  maxResponsePages: number;
}

type SnippetPageEvents = ReturnType<typeof createSnippetPageEvents>;

type RealmFactories = {
  adopt: (value: UntrustedValue) => UntrustedValue;
  installPage: (hostGetter: () => UntrustedValue) => void;
  make: (hostFunction: (...args: UntrustedValue[]) => UntrustedValue) =>
    (...args: UntrustedValue[]) => UntrustedValue;
  makeTracked: (hostFunction: (...args: UntrustedValue[]) => UntrustedValue) =>
    (...args: UntrustedValue[]) => Promise<UntrustedValue>;
  makePages: (hostGetter: () => UntrustedValue[]) => UntrustedValue[];
};

export type WorkerRealm = {
  context: vm.Context;
  cache: WeakMap<object, UntrustedValue>;
  adopt: RealmFactories["adopt"];
  installPage: RealmFactories["installPage"];
  safeFunction: RealmFactories["make"];
  safeTrackedFunction: RealmFactories["makeTracked"];
  makePages: RealmFactories["makePages"];
  pageEvents: SnippetPageEvents;
};

// Page.on/once/off stay in the set so Request/Context/Frame never expose raw
// EventEmitter hooks. wrap() substitutes a dispatcher that accepts only
// console and pageerror, and cannot remove the worker's own listeners.
const FORBIDDEN_PROPERTIES = new Set([
  "addListener",
  "browser",
  "constructor",
  "context",
  "exposeBinding",
  "exposeFunction",
  "newCDPSession",
  "off",
  "on",
  "once",
  "prependListener",
  "removeAllListeners",
  "removeListener",
  "request",
  "route",
  "routeFromHAR",
  "routeWebSocket",
  "screenshot",
  "serviceWorkers",
  "unroute",
  "unrouteAll",
]);
const BROWSER_SERIALIZED_CALLBACK_METHODS = new Set([
  "$eval",
  "$$eval",
  "addInitScript",
  "evaluate",
  "evaluateAll",
  "evaluateHandle",
  "waitForFunction",
]);

function isWrappableValue(value: UntrustedValue): value is UntrustedValue & object {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

function isSymbolValue(value: UntrustedValue): value is symbol {
  return typeof value === "symbol";
}

function isBigIntValue(value: UntrustedValue): value is bigint {
  return typeof value === "bigint";
}

function isInvocable(
  value: UntrustedValue,
): value is (...args: UntrustedValue[]) => UntrustedValue {
  return typeof value === "function";
}

export function createWorkerRealm(deps: WorkerRealmDependencies) {
  const facadeToRaw = new WeakMap<object, UntrustedValue & object>();

  function objectKind(value) {
    try {
      return String(value?.constructor?.name || "")
        .replace(/^_+/, "")
        .replace(/\d+$/, "");
    } catch {
      return "";
    }
  }

  function propertyForbidden(value, property) {
    if (
      !isString(property) ||
      property.startsWith("_") ||
      FORBIDDEN_PROPERTIES.has(property)
    )
      return true;
    const kind = objectKind(value);
    if (
      kind === "BrowserContext" &&
      [
        "addCookies",
        "clearCookies",
        "close",
        "cookies",
        "newPage",
        "pages",
        "setStorageState",
        "storageState",
        "tracing",
      ].includes(property)
    )
      return true;
    if (
      kind === "Download" &&
      ["createReadStream", "path", "saveAs"].includes(property)
    )
      return true;
    if (
      kind === "Request" &&
      [
        "allHeaders",
        "headerValue",
        "headersArray",
      ].includes(property)
    )
      return true;
    if (
      kind === "Response" &&
      [
        "allHeaders",
        "headerValue",
        "headerValues",
        "headersArray",
      ].includes(property)
    )
      return true;
    return false;
  }

  function filterModelHeaders(headers) {
    const filtered = {};
    for (const [name, value] of Object.entries(headers || {})) {
      if (["cookie", "set-cookie"].includes(name.toLowerCase())) continue;
      filtered[name] = value;
    }
    return filtered;
  }

  function isWithin(candidate, root) {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  }

  function assertReadableBrowserPath(candidate) {
    if (!isString(candidate) || !candidate) return;
    let resolved;
    let root;
    try {
      resolved = fs.realpathSync(candidate);
      root = fs.realpathSync(deps.artifactsDir());
    } catch {
      throw new Error(
        "Browser file inputs must reference an existing file inside the artifact directory.",
      );
    }
    if (!isWithin(resolved, root))
      throw new Error(
        "Browser file inputs may only read files inside the artifact directory.",
      );
  }

  function assertArtifactWritePath(candidate) {
    if (!isString(candidate) || !candidate) return;
    if (!isWithin(candidate, deps.artifactsDir())) {
      throw new Error(
        "Browser-created files must use artifactPath() or the screenshot() helper.",
      );
    }
  }

  function prepareArgument(value, property, realm) {
    if (facadeToRaw.has(value)) return facadeToRaw.get(value);
    if (isInvocable(value)) {
      if (BROWSER_SERIALIZED_CALLBACK_METHODS.has(property)) return value;
      return (...args) =>
        value(...args.map((item) => realm.adopt(wrap(item, realm))));
    }
    if (Array.isArray(value))
      return value.map((item) => prepareArgument(item, property, realm));
    // RegExp values originate in the model's vm realm. Treating them as plain
    // objects erases their non-enumerable source/flags and turns valid
    // Playwright text/name matchers into {}, which later stringify as
    // "[object Object]" inside internal selectors.
    if (utilTypes.isRegExp(value)) return new RegExp(value.source, value.flags);
    if (isObjectValue(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          prepareArgument(item, property, realm),
        ]),
      );
    }
    return value;
  }

  function argumentType(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    if (value === undefined) return "undefined";
    if (isString(value)) return "string";
    if (isNumber(value)) return "number";
    if (isBoolean(value)) return "boolean";
    if (isCallable(value)) return "function";
    if (isSymbolValue(value)) return "symbol";
    if (isBigIntValue(value)) return "bigint";
    return "object";
  }

  function validateMethodArguments(property, args) {
    if (property !== "getByRole" || args[1]?.name === undefined) return;
    const name = args[1].name;
    if (isString(name) || utilTypes.isRegExp(name)) return;
    throw new TypeError(
      `getByRole name must be a string or RegExp, received ${argumentType(name)}.`,
    );
  }

  function assertPageHandle(value, helper) {
    if (isString(value) || isNumber(value) || objectKind(facadeToRaw.get(value)) === "Page") return;
    throw new TypeError(
      `${helper} page handle must be a page ID string, numeric index, or page object, received ${argumentType(value)}.`,
    );
  }

  // Resolve a page handle — an id, an index, or the page object `openPage`/`pages`
  // hand out — to the session's `[id, page]` entry, or undefined when it is not
  // an open page of this session.
  function findPageEntry(entries, handle) {
    if (isNumber(handle)) return entries[handle];
    if (facadeToRaw.has(handle)) {
      const raw = facadeToRaw.get(handle);
      return entries.find(([, page]) => page === raw);
    }
    return entries.find(([id]) => id === String(handle));
  }

  function describePageHandle(handle) {
    if (!facadeToRaw.has(handle)) return String(handle);
    const id = deps.pageIds.get(facadeToRaw.get(handle));
    return id ? `page object ${id}` : "page object";
  }

  function validateMethodPaths(kind, property, args) {
    if (deps.hostOwnedTarget() &&
        ((kind === "BrowserContext" && ["newPage", "close"].includes(property)) ||
         (kind === "Page" && property === "close"))) {
      throw new Error("Host-owned tabs must be opened or closed by the host.");
    }
    if (kind === "Page" && property === "pdf" && args[0]?.path)
      assertArtifactWritePath(args[0].path);
    if (
      ["addInitScript", "addScriptTag", "addStyleTag"].includes(property) &&
      args[0]?.path
    ) {
      assertReadableBrowserPath(args[0].path);
    }
    if (property === "setInputFiles" || property === "setFiles") {
      const supplied =
        property === "setFiles" || ["Locator", "ElementHandle"].includes(kind)
          ? args[0]
          : args[1];
      const files = Array.isArray(supplied) ? supplied : [supplied];
      for (const file of files) {
        if (deps.hostOwnedTarget()) {
          if (!isString(file) || !deps.hostUploadFiles()?.includes(file) ||
              fs.realpathSync(file) !== file || !fs.statSync(file).isFile()) {
            throw new Error("Host upload requires an exact approved regular staged file.");
          }
        } else if (isString(file)) assertReadableBrowserPath(file);
      }
    }
    if (["Page", "Frame"].includes(kind) && property === "goto") {
      assertModelNavigationUrl(args[0]);
    }
  }

  async function setContentCompatible(target, html, options: any = {}) {
    if (!isString(html)) {
      throw new TypeError("setContent requires an HTML string.");
    }
    const waitUntil = String(options?.waitUntil || "load");
    if (!["commit", "domcontentloaded", "load", "networkidle"].includes(waitUntil)) {
      throw new TypeError(`Unsupported setContent waitUntil value: ${waitUntil}`);
    }
    const frame = objectKind(target) === "Frame" ? target : target.mainFrame();
    const page = frame.page();
    const timeout = frame._navigationTimeout(options || {});
    const deadline = timeout === 0 ? Number.POSITIVE_INFINITY : Date.now() + timeout;
    const inflight = new Set();
    let lastNetworkActivity = Date.now();
    const belongsToFrame = (request) => {
      try {
        let current = request.frame();
        while (current) {
          if (current === frame) return true;
          current = current.parentFrame();
        }
        return false;
      } catch {
        return false;
      }
    };
    const onRequest = (request) => {
      if (!belongsToFrame(request)) return;
      inflight.add(request);
      lastNetworkActivity = Date.now();
    };
    const onRequestDone = (request) => {
      if (!inflight.delete(request)) return;
      lastNetworkActivity = Date.now();
    };
    if (waitUntil === "networkidle") {
      page.on("request", onRequest);
      page.on("requestfinished", onRequestDone);
      page.on("requestfailed", onRequestDone);
    }
    const remaining = () => {
      if (timeout === 0) return 0;
      const value = deadline - Date.now();
      if (value <= 0) {
        throw new Error(`setContent: Timeout ${timeout}ms exceeded.`);
      }
      return value;
    };
    try {
      await frame.evaluate(({ markup, expected, timeoutMs }) => {
        document.open();
        if (expected === "commit") {
          document.write(markup);
          document.close();
          return undefined;
        }
        return new Promise((resolve, reject) => {
          let settled = false;
          const finish = (error = null) => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimeout(timer);
            if (error) reject(error);
            else resolve(undefined);
          };
          const eventName = expected === "domcontentloaded"
            ? "DOMContentLoaded"
            : "load";
          const eventTarget = expected === "domcontentloaded" ? document : window;
          eventTarget.addEventListener(eventName, () => finish(), { once: true });
          const timer = timeoutMs > 0
            ? setTimeout(
                () => finish(new Error(`setContent: Timeout ${timeoutMs}ms exceeded.`)),
                timeoutMs,
              )
            : null;
          document.write(markup);
          document.close();
        });
      }, { markup: html, expected: waitUntil, timeoutMs: remaining() });
      if (waitUntil === "commit") return;
      while (
        inflight.size > 0 ||
        (waitUntil === "networkidle" && Date.now() - lastNetworkActivity < 500)
      ) {
        remaining();
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))),
        );
      }
    } catch (error) {
      if (timeout !== 0 && Date.now() >= deadline) {
        throw new Error(`setContent: Timeout ${timeout}ms exceeded.`);
      }
      throw error;
    } finally {
      if (waitUntil === "networkidle") {
        page.off("request", onRequest);
        page.off("requestfinished", onRequestDone);
        page.off("requestfailed", onRequestDone);
      }
    }
  }

  function assertModelNavigationUrl(value) {
    const url = String(value || "");
    let scheme;
    try {
      scheme = new URL(url).protocol.toLowerCase();
    } catch {
      throw new Error("Browser navigation requires a valid URL.");
    }
    const safeSpecial =
      (scheme === "about:" && url.toLowerCase() === "about:blank") ||
      scheme === "data:" ||
      scheme === "blob:";
    if (!safeSpecial && !["http:", "https:"].includes(scheme)) {
      throw new Error(`Browser navigation scheme is not available: ${scheme}`);
    }
    if (
      ["http:", "https:"].includes(scheme) &&
      String(deps.publicSearchPolicy() || "block") !== "allow" &&
      isPublicSearchNavigation(url)
    ) {
      throw new Error(PUBLIC_SEARCH_BLOCK_ADVICE);
    }
  }

  let realmFactoryScript: vm.Script | null = null;

  // The factory source is a constant template with no interpolation, so the parse
  // is realm-independent: compile on first use and reuse the script thereafter.
  function getRealmFactoryScript() {
    if (realmFactoryScript) return realmFactoryScript;
    realmFactoryScript = new vm.Script(
      `(() => {
      const PromiseCtor = Promise;
      const ErrorCtor = Error;
      const ArrayCtor = Array;
      const errorMessage = error => {
        try { return String(error && error.message ? error.message : error); }
        catch { return 'Playwright operation failed'; }
      };
      const adopt = value => ArrayCtor.isArray(value) ? ArrayCtor.from(value, adopt) : value;
      const bridge = (result, markHandled = null) => {
        const bridged = new PromiseCtor((resolve, reject) => {
          result.then(
            value => resolve(adopt(value)),
            error => reject(new ErrorCtor(errorMessage(error))),
          );
        });
        const silence = promise => {
          PromiseCtor.prototype.catch.call(promise, () => {});
          return promise;
        };
        silence(bridged);
        if (typeof markHandled !== 'function') return bridged;
        const tracked = promise => new Proxy(silence(promise), {
          get(target, property) {
            if (property === 'then') {
              return (onFulfilled, onRejected) => {
                if (typeof onRejected === 'function') markHandled();
                return tracked(PromiseCtor.prototype.then.call(
                  target,
                  onFulfilled,
                  onRejected,
                ));
              };
            }
            if (property === 'catch') {
              return onRejected => {
                if (typeof onRejected === 'function') markHandled();
                return tracked(PromiseCtor.prototype.catch.call(target, onRejected));
              };
            }
            if (property === 'finally') {
              return onFinally => tracked(
                PromiseCtor.prototype.finally.call(target, onFinally),
              );
            }
            return Reflect.get(target, property, target);
          },
        });
        return tracked(bridged);
      };
      const call = (hostFunction, args) => {
        let result;
        try { result = hostFunction(...args); }
        catch (error) { throw new ErrorCtor(errorMessage(error)); }
        return result;
      };
      const make = hostFunction => (...args) => {
        const result = call(hostFunction, args);
        if (result && typeof result.then === 'function') return bridge(result);
        return adopt(result);
      };
      const makeTracked = hostFunction => (...args) => {
        const tracked = call(hostFunction, args);
        return bridge(tracked.promise, tracked.markHandled);
      };
      const makePages = hostGetter => {
        const getPages = make(hostGetter);
        return new Proxy([], {
          get(_target, property) {
            const list = getPages();
            const member = list[property];
            return typeof member === 'function' ? member.bind(list) : member;
          },
          has(_target, property) { return property in getPages(); },
          ownKeys() { return Reflect.ownKeys(getPages()); },
          getOwnPropertyDescriptor() { return { configurable: true, enumerable: true }; },
        });
      };
      const installPage = hostGetter => {
        const getPage = make(hostGetter);
        Object.defineProperty(globalThis, 'page', {
          configurable: false,
          enumerable: true,
          get: getPage,
        });
      };
      return { adopt, installPage, make, makePages, makeTracked };
    })()`,
      { filename: "browser-playwright-realm.js" },
    );
    return realmFactoryScript;
  }

  // WHATWG URL is not a JS intrinsic, so a fresh vm context lacks it, and the
  // host's `URL` cannot be handed over: its `constructor` is the host realm's
  // `Function`, which compiles code outside the context's restrictions. These
  // classes live in the snippet realm and only ever receive strings and arrays
  // of strings from the host, which `adopt` turns into realm values.
  const URL_FIELDS = ["href", "protocol", "username", "password", "host", "hostname", "port", "pathname", "search", "hash", "origin"];

  function urlParts(input, base, field, value) {
    let url;
    try {
      url = new URL(input, base);
    } catch {
      throw new TypeError(`Invalid URL: ${input}`);
    }
    if (field) url[field] = value;
    return URL_FIELDS.map((name) => url[name]);
  }

  let urlFactoryScript: vm.Script | null = null;

  function getUrlFactoryScript() {
    if (urlFactoryScript) return urlFactoryScript;
    urlFactoryScript = new vm.Script(
      `(fields, urlParts, parseParams, serializeParams) => {
      const pairsOf = new WeakMap();
      const owners = new WeakMap();
      // Writing the owner's search re-enters the field setter below; the flag
      // stops it from re-parsing the pairs it was just serialized from.
      let syncing = false;
      const sync = params => {
        const owner = owners.get(params);
        if (!owner) return;
        syncing = true;
        try { owner.search = serializeParams(pairsOf.get(params)); } finally { syncing = false; }
      };
      // Names and values are WebIDL USVStrings: lone surrogates become U+FFFD.
      const usv = value => String(value).toWellFormed();
      // WHATWG init: a string, an iterable of [name, value] pairs (array, Map,
      // generator, another URLSearchParams), or a record of name -> value.
      const pairsFrom = init => {
        if (init === undefined) return [];
        if (init !== null && (typeof init === 'object' || typeof init === 'function')) {
          const iterator = init[Symbol.iterator];
          if (iterator !== undefined && iterator !== null) {
            if (typeof iterator !== 'function') throw new TypeError('Query init is not iterable');
            const pairs = [];
            for (const pair of { [Symbol.iterator]: () => iterator.call(init) }) {
              if (pair === null || pair === undefined || typeof pair[Symbol.iterator] !== 'function')
                throw new TypeError('Each query pair must be an iterable [name, value] entry');
              const entry = [...pair];
              if (entry.length !== 2)
                throw new TypeError('Each query pair must be an iterable [name, value] entry');
              pairs.push([usv(entry[0]), usv(entry[1])]);
            }
            return pairs;
          }
          return Object.entries(init).map(([key, value]) => [usv(key), usv(value)]);
        }
        return parseParams(usv(init));
      };
      // The pair list is only ever mutated in place, so an iterator holding an
      // index into it stays live across delete()/set() like the native one.
      const replace = (params, pairs) => { const list = pairsOf.get(params); list.splice(0, list.length, ...pairs); };
      function* iterate(params, pick) {
        for (let i = 0; i < pairsOf.get(params).length; i += 1) yield pick(pairsOf.get(params)[i]);
      }
      class URLSearchParams {
        constructor(init = '') { pairsOf.set(this, pairsFrom(init)); }
        get size() { return pairsOf.get(this).length; }
        append(key, value) { pairsOf.get(this).push([usv(key), usv(value)]); sync(this); }
        delete(key, value) {
          key = usv(key);
          if (value !== undefined) value = usv(value);
          const pairs = pairsOf.get(this);
          for (let i = pairs.length - 1; i >= 0; i -= 1) {
            if (pairs[i][0] === key && (value === undefined || pairs[i][1] === value)) pairs.splice(i, 1);
          }
          sync(this);
        }
        get(key) { key = usv(key); const hit = pairsOf.get(this).find(([k]) => k === key); return hit ? hit[1] : null; }
        getAll(key) { key = usv(key); return pairsOf.get(this).filter(([k]) => k === key).map(([, v]) => v); }
        has(key, value) { key = usv(key); return pairsOf.get(this).some(([k, v]) => k === key && (value === undefined || v === usv(value))); }
        set(key, value) {
          key = usv(key);
          value = usv(value);
          const pairs = pairsOf.get(this);
          const index = pairs.findIndex(([k]) => k === key);
          if (index < 0) pairs.push([key, value]);
          else {
            pairs[index] = [key, value];
            for (let i = pairs.length - 1; i > index; i -= 1) if (pairs[i][0] === key) pairs.splice(i, 1);
          }
          sync(this);
        }
        sort() { pairsOf.get(this).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)); sync(this); }
        forEach(callback, thisArg) { for (const [key, value] of this) callback.call(thisArg, value, key, this); }
        keys() { return iterate(this, ([key]) => key); }
        values() { return iterate(this, ([, value]) => value); }
        entries() { return iterate(this, ([key, value]) => [key, value]); }
        [Symbol.iterator]() { return this.entries(); }
        toString() { return serializeParams(pairsOf.get(this)); }
        get [Symbol.toStringTag]() { return 'URLSearchParams'; }
      }
      const partsOf = new WeakMap();
      const paramsOf = new WeakMap();
      const assign = (url, values) => partsOf.set(url, Object.fromEntries(fields.map((name, i) => [name, values[i]])));
      class URL {
        constructor(input, base) {
          assign(this, urlParts(String(input), base === undefined ? undefined : String(base)));
        }
        static canParse(input, base) { try { new URL(input, base); return true; } catch { return false; } }
        static parse(input, base) { try { return new URL(input, base); } catch { return null; } }
        get searchParams() {
          let params = paramsOf.get(this);
          if (!params) {
            params = new URLSearchParams(partsOf.get(this).search);
            owners.set(params, this);
            paramsOf.set(this, params);
          }
          return params;
        }
        toString() { return partsOf.get(this).href; }
        toJSON() { return partsOf.get(this).href; }
        get [Symbol.toStringTag]() { return 'URL'; }
      }
      for (const name of fields) {
        Object.defineProperty(URL.prototype, name, {
          configurable: true,
          enumerable: true,
          get() { return partsOf.get(this)[name]; },
          set: name === 'origin' ? undefined : function (value) {
            assign(this, urlParts(partsOf.get(this).href, undefined, name, String(value)));
            // searchParams keeps its identity (WHATWG) and follows every
            // mutation of the query, whether through search, href, or the
            // params object itself.
            const params = paramsOf.get(this);
            if (params && !syncing) replace(params, parseParams(partsOf.get(this).search));
          },
        });
      }
      return { URL, URLSearchParams };
    }`,
      { filename: "browser-url-realm.js" },
    );
    return urlFactoryScript;
  }

  function createUrlGlobals(realm: WorkerRealm) {
    const factory = getUrlFactoryScript().runInContext(realm.context);
    return factory(
      realm.adopt(URL_FIELDS),
      realm.safeFunction(urlParts),
      realm.safeFunction((init) => [...new URLSearchParams(init)]),
      realm.safeFunction((pairs) => new URLSearchParams(pairs).toString()),
    );
  }

  function createRealm(context: vm.Context, pageEvents: SnippetPageEvents): WorkerRealm {
    // SAFETY: the constant factory script returns this exact five-method record.
    const factories = getRealmFactoryScript().runInContext(context) as RealmFactories;
    return {
      context,
      cache: new WeakMap(),
      adopt: factories.adopt,
      installPage: factories.installPage,
      safeFunction: factories.make,
      safeTrackedFunction: factories.makeTracked,
      makePages: factories.makePages,
      pageEvents,
    };
  }

  function wrap(value, realm: WorkerRealm) {
    if (!isWrappableValue(value)) return value;
    if (facadeToRaw.has(value)) return value;
    if (Array.isArray(value)) return value.map((item) => wrap(item, realm));
    const cached = realm.cache.get(value);
    if (cached) return cached;

    const facade = new Proxy(Object.create(null), {
      get(_target, property) {
        if (property === Symbol.toStringTag) return "PlaywrightObject";
        if (isSymbolValue(property)) return undefined;
        if (isSnippetPageEventMethod(objectKind(value), property)) {
          return realm.safeFunction((event, listener) => {
            realm.pageEvents.dispatch(
              value,
              property,
              event,
              listener,
              (payload) => realm.adopt(wrap(payload, realm)),
            );
            return wrap(value, realm);
          });
        }
        if (propertyForbidden(value, property)) return undefined;
        const member = value[property];
        if (!isCallable(member)) return wrap(member, realm);
        return realm.safeFunction((...args) => {
          const prepared = args.map((arg) =>
            prepareArgument(arg, property, realm),
          );
          const kind = objectKind(value);
          validateMethodArguments(property, prepared);
          validateMethodPaths(kind, property, prepared);
          applyNavigationDefaults(kind, property, prepared);
          let result;
          if (kind === "Page" && property === "close") {
            // SAFETY: objectKind identified this Playwright value as a Page.
            result = deps.stopPageRecording(value as Page).then(() => member.apply(value, prepared));
          } else if (kind === "Page" && (property === "goBack" || property === "goForward")) {
            result = navigateHistory(value, property, prepared[0], deps.defaultNavigationTimeoutMs);
          } else if (
            deps.useSetContentCompatibility() &&
            ["Page", "Frame"].includes(kind) &&
            property === "setContent"
          ) {
            result = setContentCompatible(value, prepared[0], prepared[1]);
          } else {
            result = member.apply(value, prepared);
          }
          if (["Keyboard", "Page", "Frame", "Locator"].includes(kind) &&
              ["press", "pressSequentially", "type", "fill", "down"].includes(property) && result?.catch) {
            result = result.catch(async (error) => {
              // A failed chord can skip Playwright's key-up sequence.
              const target: any = value;
              const keyboard = kind === "Keyboard" ? target : kind === "Page" ? target.keyboard : target.page().keyboard;
              for (const key of ["AltLeft", "AltRight", "ControlLeft", "ControlRight", "MetaLeft", "MetaRight", "ShiftLeft", "ShiftRight"]) {
                await keyboard.up(key).catch(() => {});
              }
              throw error;
            });
          }
          if (
            ["Request", "Response"].includes(kind) &&
            property === "headers"
          ) {
            result = result && isCallable(untrustedField(result, "then"))
              ? result.then(filterModelHeaders)
              : filterModelHeaders(result);
          }
          if (result && isCallable(untrustedField(result, "then"))) {
            return result.then((item) => wrap(item, realm));
          }
          return wrap(result, realm);
        });
      },
      has(_target, property) {
        if (isSnippetPageEventMethod(objectKind(value), property)) return true;
        return !propertyForbidden(value, property) && property in value;
      },
      ownKeys() {
        return Reflect.ownKeys(value).filter(
          (key) => !propertyForbidden(value, key),
        );
      },
      getOwnPropertyDescriptor() {
        return { configurable: true, enumerable: true };
      },
      getPrototypeOf() {
        return null;
      },
      set() {
        return false;
      },
    });
    realm.cache.set(value, facade);
    facadeToRaw.set(facade, value);
    return facade;
  }

  function summaryText(value, maxLength = 4_000) {
    return deps.redactText(String(value ?? "")).slice(0, maxLength);
  }

  async function callSummaryMethod(value, method, fallback = null) {
    try {
      if (!isCallable(value?.[method])) return fallback;
      return await value[method]();
    } catch {
      return fallback;
    }
  }

  async function summarizePlaywrightObject(raw, kind) {
    if (kind === "Frame") {
      return {
        type: "Frame",
        name: summaryText(await callSummaryMethod(raw, "name", "")),
        url: summaryText(await callSummaryMethod(raw, "url", "")),
        detached: Boolean(await callSummaryMethod(raw, "isDetached", true)),
      };
    }
    if (kind === "ConsoleMessage") {
      const location = await callSummaryMethod(raw, "location", {});
      return {
        type: "ConsoleMessage",
        level: summaryText(await callSummaryMethod(raw, "type", ""), 80),
        text: summaryText(await callSummaryMethod(raw, "text", "")),
        location: {
          url: summaryText(location?.url || ""),
          lineNumber: Number(location?.lineNumber) || 0,
          columnNumber: Number(location?.columnNumber) || 0,
        },
      };
    }
    if (kind === "Request") {
      return {
        type: "Request",
        url: summaryText(await callSummaryMethod(raw, "url", "")),
        method: summaryText(await callSummaryMethod(raw, "method", ""), 40),
        resourceType: summaryText(
          await callSummaryMethod(raw, "resourceType", ""),
          80,
        ),
        navigation: Boolean(
          await callSummaryMethod(raw, "isNavigationRequest", false),
        ),
      };
    }
    if (kind === "Response") {
      return {
        type: "Response",
        url: summaryText(await callSummaryMethod(raw, "url", "")),
        status: Number(await callSummaryMethod(raw, "status", 0)) || 0,
        statusText: summaryText(
          await callSummaryMethod(raw, "statusText", ""),
          200,
        ),
        ok: Boolean(await callSummaryMethod(raw, "ok", false)),
      };
    }
    if (kind === "Dialog") {
      return {
        type: "Dialog",
        dialogType: summaryText(await callSummaryMethod(raw, "type", ""), 80),
        message: summaryText(await callSummaryMethod(raw, "message", "")),
        defaultValue: summaryText(
          await callSummaryMethod(raw, "defaultValue", ""),
        ),
      };
    }
    if (kind === "Download") {
      return {
        type: "Download",
        url: summaryText(await callSummaryMethod(raw, "url", "")),
        suggestedFilename: summaryText(
          await callSummaryMethod(raw, "suggestedFilename", ""),
          300,
        ),
      };
    }
    if (kind === "WebSocket" || kind === "Worker") {
      return {
        type: kind,
        url: summaryText(await callSummaryMethod(raw, "url", "")),
      };
    }
    if (kind === "FileChooser") {
      return {
        type: "FileChooser",
        multiple: Boolean(await callSummaryMethod(raw, "isMultiple", false)),
      };
    }
    // Handles, contexts, sessions, routes, videos, and future Playwright classes
    // fail closed. Their enumerable fields include transport channels and host
    // process state that must never cross the model boundary.
    return { type: kind || "PlaywrightObject" };
  }

  /**
   * JSON-safe summary of a sandbox value as `summarize` produces it: primitives
   * pass through and every container is reduced to plain arrays and objects.
   */
  type SummarizedValue =
    | null
    | string
    | number
    | boolean
    | SummarizedValue[]
    | { [key: string]: SummarizedValue };

  async function summarize(value, seen = new WeakSet(), depth = 0) {
    if (value === undefined) return null;
    if (value === null || isString(value) || isNumber(value) || isBoolean(value))
      return deps.redactDeep(value);
    if (isBigIntValue(value)) return value.toString();
    if (isCallable(value))
      return `[Function ${value.name || "anonymous"}]`;
    const raw = facadeToRaw.get(value) || value;
    if (raw instanceof Error)
      return { name: raw.name, message: deps.redactText(raw.message) };
    if (depth > 8) return "[Max depth]";
    if (seen.has(raw)) return "[Circular]";
    seen.add(raw);

    const kind = objectKind(raw);
    if (deps.pageIds.has(raw)) {
      // SAFETY: only Playwright Page objects are registered in pageIds.
      const page = raw as Page;
      let title = "";
      try {
        const domTitle = await page
          .evaluate(
            () => document.title || document.querySelector("title")?.textContent || "",
          )
          .catch(() => "");
        if (isString(domTitle) && domTitle) title = domTitle;
        else title = await page.title();
      } catch {
        /* page may have closed */
      }
      return {
        type: "Page",
        pageId: deps.pageId(page),
        url: deps.redactText(page.url()),
        title: deps.redactText(title),
        closed: page.isClosed(),
      };
    }
    if (kind === "Locator")
      return { type: "Locator", locator: deps.redactText(raw.toString()) };
    if (Array.isArray(raw))
      return Promise.all(
        raw.slice(0, 200).map((item) => summarize(item, seen, depth + 1)),
      );
    if (raw instanceof Map) {
      const entries = [...raw.entries()].slice(0, 200);
      return Object.fromEntries(
        await Promise.all(
          entries.map(async ([key, item]) => [
            deps.redactText(key),
            await summarize(item, seen, depth + 1),
          ]),
        ),
      );
    }
    if (raw instanceof Set)
      return Promise.all(
        [...raw].slice(0, 200).map((item) => summarize(item, seen, depth + 1)),
      );
    if (kind !== "Object" && kind !== "") {
      return summarizePlaywrightObject(raw, kind);
    }
    const output: Record<string, SummarizedValue> = {};
    for (const key of Object.keys(raw).slice(0, 200)) {
      try {
        output[deps.redactText(key)] = await summarize(raw[key], seen, depth + 1);
      } catch (error) {
        output[deps.redactText(key)] = `[Unserializable: ${error?.message || error}]`;
      }
    }
    return deps.redactDeep(output);
  }

  async function summarizeSessionPages(session: WorkerSession) {
    return Promise.all(
      [...session.pages.values()]
        .filter((page) => !page.isClosed())
        .slice(0, deps.maxResponsePages)
        .map(async (page) => ({
          ...(await summarize(page)),
          active: deps.pageId(page) === session.currentId,
        })),
    );
  }

  function unwrapTarget(value: UntrustedValue) {
    return facadeToRaw.get(value) || value;
  }

  return {
    assertModelNavigationUrl,
    assertPageHandle,
    createRealm,
    createUrlGlobals,
    describePageHandle,
    findPageEntry,
    objectKind,
    summarize,
    summarizeSessionPages,
    unwrapTarget,
    wrap,
  };
}

export type WorkerRealmOperations = ReturnType<typeof createWorkerRealm>;
