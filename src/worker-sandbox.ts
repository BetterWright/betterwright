// Model-callable helpers assembled for one execution. The process entrypoint
// supplies trusted operations; browser and configuration access stays live.
import vm from "node:vm";
import type { BrowserContext, Page } from "playwright-core";
import { CAPTCHA_SCREENSHOT_TIMEOUT_MS, captchaBounds, captchaBoxInViewport, captchaPoint, captchaTilesStale, type createCaptchaRuntime, detectCaptchaOnPage } from "./captcha-runtime.js";
import { parseTileIndexes } from "./captcha-solver.js";
import type { createCredentialFill } from "./credential-fill.js";
import { movePointer, pressPointer, scrollWheel, typedTextLanded, typeText } from "./human.js";
import { navigationOptions } from "./navigation-defaults.js";
import { dismissObstructiveOverlays, inspectActionDirectory, inspectControls, inspectMedia } from "./page-inspect.js";
import { siteTextExcerpts } from "./site-tools.js";
import { executeUIBatch } from "./ui-batch.js";
import { isObjectValue, isString, type UntrustedValue, untrustedField } from "./untrusted-value.js";
import { prepareWebAgentsBatch, publicWebAgentsManifest } from "./webagents.js";
import { invokeWebMCPTool, listWebMCPTools } from "./webmcp.js";
import type { createWorkerArtifacts } from "./worker-artifacts.js";
import type { createHumanInput } from "./worker-human.js";
import type { createWorkerRealm, WorkerRealm } from "./worker-realm.js";
import { MAX_PAGES_PER_SESSION, type WorkerSession } from "./worker-session.js";
import type { createWorkerSite } from "./worker-site.js";
import type { createWorkerSnapshots } from "./worker-snapshots.js";

const MAX_CONSOLE_MESSAGES = 20;
const MAX_CONSOLE_MESSAGE_CHARS = 300;

interface ScreenshotOptions {
  name?: string;
  kind?: string;
  type?: string;
  fullPage?: boolean;
  annotate?: boolean;
  quality?: number;
}

interface ScreenshotArtifact {
  kind: string;
  path: string;
  media: string;
  annotations?: number;
}

function hostDelay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ArtifactOperations = ReturnType<typeof createWorkerArtifacts<WorkerSession>>;
type RealmOperations = ReturnType<typeof createWorkerRealm>;
type CredentialOperations = ReturnType<typeof createCredentialFill>;

// The per-execute record shared with credential tasks; the sandbox only reads
// its page events, credential-fill.ts owns the task bookkeeping.
interface SandboxExecution {
  acceptingCredentialTasks: boolean;
  credentialTasks: unknown[];
  pageEvents: WorkerRealm["pageEvents"];
}

interface WorkerSandboxDeps extends
  Pick<RealmOperations, "createRealm" | "wrap" | "createUrlGlobals" | "assertPageHandle" | "findPageEntry" | "describePageHandle" | "assertModelNavigationUrl">,
  Pick<ArtifactOperations, "stopPageRecording" | "makeArtifactPath" | "startSessionRecording" | "stopSessionRecording" | "sessionRecordingStatus" | "addScreenshotAnnotations" | "captureScreenshot" | "removeScreenshotAnnotations">,
  ReturnType<typeof createHumanInput>,
  Pick<ReturnType<typeof createWorkerSite>, "pageSiteRequests" | "inspectSiteAssets" | "pageSiteRequest" | "discoverPageWebAgents">,
  Pick<ReturnType<typeof createWorkerSnapshots>, "snapshotPage">,
  ReturnType<typeof createCaptchaRuntime<WorkerSession>> {
  getConfig: () => { hostOwnedTarget?: boolean };
  getBrowserContext: () => BrowserContext;
  redactText: (value: UntrustedValue) => string;
  adoptPage: (page: Page, sessionId: string) => Page;
  notifyLiveViewPreferred: () => void;
  ensureSessionPage: (session: WorkerSession) => Promise<Page>;
  buildCredentials: CredentialOperations["buildCredentials"];
}

export function createWorkerSandbox({
  getConfig,
  getBrowserContext,
  createRealm,
  wrap,
  createUrlGlobals,
  assertPageHandle,
  findPageEntry,
  describePageHandle,
  assertModelNavigationUrl,
  redactText,
  adoptPage,
  notifyLiveViewPreferred,
  stopPageRecording,
  ensureSessionPage,
  snapshotPage,
  makeArtifactPath,
  startSessionRecording,
  stopSessionRecording,
  sessionRecordingStatus,
  addScreenshotAnnotations,
  captureScreenshot,
  removeScreenshotAnnotations,
  solveCaptchaOnPage,
  captureTiles,
  clickStoredTiles,
  humanClickTarget,
  clearTypedField,
  moveTypedFieldCaretToEnd,
  readTypedFieldText,
  restoreTypedFieldText,
  insertTypedText,
  pageSiteRequests,
  inspectSiteAssets,
  pageSiteRequest,
  discoverPageWebAgents,
  buildCredentials,
}: WorkerSandboxDeps) {

  function buildCaptcha(session: WorkerSession, realm: WorkerRealm) {
    const captcha = Object.create(null);
    captcha.detect = realm.safeFunction(async () => {
      const page = await ensureSessionPage(session);
      return detectCaptchaOnPage(page);
    });
    captcha.solve = realm.safeFunction(async (options: any = {}) => {
      const page = await ensureSessionPage(session);
      return solveCaptchaOnPage(page, session, options || {});
    });
    captcha.click = realm.safeFunction(async (bounds) => {
      const page = await ensureSessionPage(session);
      const target = captchaBounds(bounds);
      const stored = [...session.captchaTargets.values()].find(
        (entry) =>
          Math.abs(entry.bounds.x - target.x) < 2 &&
          Math.abs(entry.bounds.y - target.y) < 2 &&
          Math.abs(entry.bounds.width - target.width) < 2 &&
          Math.abs(entry.bounds.height - target.height) < 2,
      );
      const visibleTarget = await captchaBoxInViewport(
        page,
        stored?.pageBounds || target,
        Boolean(stored?.pageBounds),
      );
      const point = {
        x: Math.round(
          visibleTarget.x + visibleTarget.width * (0.13 + Math.random() * 0.04),
        ),
        y: Math.round(
          visibleTarget.y + visibleTarget.height * (0.44 + Math.random() * 0.12),
        ),
      };
      await movePointer(page.mouse, session.cursor, point, { stepDivisor: 8 });
      await pressPointer(page.mouse);
      await hostDelay(2_000 + Math.random() * 1_500);
      return snapshotPage(page);
    });
    captcha.drag = realm.safeFunction(async (from, to, options: any = {}) => {
      const page = await ensureSessionPage(session);
      const start = captchaPoint(from, "drag start");
      const end = captchaPoint(to, "drag end");
      const steps = Math.floor(
        Math.max(1, Math.min(100, Number(options?.steps) || 20)),
      );
      await movePointer(page.mouse, session.cursor, start, { stepDivisor: 8 });
      await hostDelay(120 + Math.random() * 180);
      await page.mouse.down();
      await hostDelay(90 + Math.random() * 150);
      await movePointer(page.mouse, session.cursor, end, {
        stepDivisor: Math.max(3, Math.hypot(end.x - start.x, end.y - start.y) / steps),
      });
      await hostDelay(100 + Math.random() * 180);
      await page.mouse.up();
      await hostDelay(1_500 + Math.random() * 1_000);
      return snapshotPage(page);
    });
    async function captureCaptcha(bounds, requested, instruction) {
      const page = await ensureSessionPage(session);
      const clip = bounds == null ? null : captchaBounds(bounds);
      const shotOptions = {
        type: "png",
        animations: "disabled",
        timeout: CAPTCHA_SCREENSHOT_TIMEOUT_MS,
      };
      const file = await captureScreenshot(
        page,
        session,
        requested,
        requested,
        clip ? { ...shotOptions, clip } : shotOptions,
      );
      const artifact = {
        kind: "captcha",
        path: file,
        media: `MEDIA:${file}`,
      };
      session.artifacts.push(artifact);
      return {
        ...artifact,
        instruction,
      };
    }
    captcha.inspect = realm.safeFunction(async (bounds) => {
      return captureCaptcha(
        bounds,
        "captcha-challenge.png",
        "Inspect the attached challenge visually, choose the matching native " +
          "CAPTCHA or human helper, then verify that the challenge cleared and " +
          "resume the original task.",
      );
    });
    captcha.readText = realm.safeFunction(async (bounds) => {
      return captureCaptcha(
        bounds,
        "captcha-text.png",
        "Read the attached CAPTCHA crop visually and return only its text.",
      );
    });
    captcha.clickTiles = realm.safeFunction(async (indexes) => {
      const page = await ensureSessionPage(session);
      const picked = parseTileIndexes(indexes);
      if (!picked.length) {
        throw new Error("captcha.clickTiles requires an array of tile indexes from the numbered crop.");
      }
      if (!session.captchaTargets.size) {
        await captureTiles(page, session, null);
      } else if (await captchaTilesStale(page, session, null)) {
        // The stored coordinates belong to a grid that is no longer on screen.
        // Recapture so the caller re-reads the crop rather than clicking blind.
        await captureTiles(page, session, null);
        throw new Error(
          "The captcha grid changed since the numbered crop was captured. " +
            "Call captcha.solve() to get a fresh crop, then pick tiles again.",
        );
      }
      const outcome = await clickStoredTiles(page, session, picked);
      if (!outcome.ok) {
        throw new Error(
          outcome.reason === "tiles_not_captured"
            ? "No numbered captcha grid is stored. Call captcha.solve() first."
            : "None of the requested captcha tile indexes were on the stored grid.",
        );
      }
      return snapshotPage(page);
    });
    return captcha;
  }

  function buildHuman(session: WorkerSession, realm: WorkerRealm) {
    const human = Object.create(null);
    human.click = realm.safeFunction(async (target, options: any = {}) => {
      const page = await ensureSessionPage(session);
      await humanClickTarget(page, session, target, options);
      return { clicked: true };
    });
    human.type = realm.safeFunction(async (target, text, options: any = {}) => {
      const page = await ensureSessionPage(session);
      const clickedTarget = await humanClickTarget(page, session, target, options);
      const clear = options?.clear !== false;
      if (clear) await clearTypedField(page, clickedTarget);
      else await moveTypedFieldCaretToEnd(page, clickedTarget);
      const expected = String(text);
      const before = await readTypedFieldText(clickedTarget);
      await typeText(page.keyboard, expected, options);
      let after = await readTypedFieldText(clickedTarget);
      if (!typedTextLanded(expected, before, after)) {
        if (clear) await clearTypedField(page, clickedTarget);
        else if (before != null) {
          await restoreTypedFieldText(clickedTarget, before);
        }
        const retryBefore = await readTypedFieldText(clickedTarget);
        await insertTypedText(page, clickedTarget, expected, retryBefore);
        after = await readTypedFieldText(clickedTarget);
      }
      if (!typedTextLanded(expected, before, after)) {
        throw new Error(
          "human.type did not change the field. The target may ignore synthetic key events (common in Draft.js and other rich-text editors).",
        );
      }
      return { typed: expected.length };
    });
    human.scroll = realm.safeFunction(async (deltaOrOptions, options: any = {}) => {
      const page = await ensureSessionPage(session);
      const settings = isObjectValue(deltaOrOptions)
        ? deltaOrOptions
        : { ...options, deltaY: deltaOrOptions };
      const deltaX = Number(untrustedField(settings, "deltaX")) || 0;
      const deltaY = Number(untrustedField(settings, "deltaY")) || 0;
      if (!deltaX && !deltaY)
        throw new Error("human.scroll requires a non-zero deltaX or deltaY.");
      await scrollWheel(page.mouse, deltaX, deltaY, settings);
      return { scrolled: { deltaX, deltaY } };
    });
    return human;
  }

  function buildSite(session: WorkerSession, realm: WorkerRealm) {
    const site = Object.create(null);
    site.requests = realm.safeFunction(async (options: any = {}) => {
      const page = await ensureSessionPage(session);
      const includes = String(options.urlIncludes || "");
      const resourceType = String(options.resourceType || "");
      const limit = Math.max(1, Math.min(512, Number(options.limit) || 100));
      return (pageSiteRequests.get(page) || [])
        .filter(
          (record) =>
            (!includes || record.url.includes(includes)) &&
            (!resourceType || record.resourceType === resourceType),
        )
        .slice(-limit);
    });
    site.assets = realm.safeFunction(async () => {
      const page = await ensureSessionPage(session);
      return inspectSiteAssets(page);
    });
    site.read = realm.safeFunction(async (url, options: any = {}) => {
      const page = await ensureSessionPage(session);
      const response = await pageSiteRequest(page, url, { method: "GET" });
      return {
        ...response,
        text: siteTextExcerpts(
          response.text,
          options.find,
          options.contextChars,
          options.maxMatches,
        ),
      };
    });
    site.request = realm.safeFunction(async (url, options: any = {}) => {
      const page = await ensureSessionPage(session);
      return pageSiteRequest(page, url, options);
    });
    return site;
  }

  function buildWebAgents(session: WorkerSession, realm: WorkerRealm) {
    const webagents = Object.create(null);
    webagents.discover = realm.safeFunction(async (options: any = {}) => {
      if (!isObjectValue(options) || Array.isArray(options)) {
        throw new TypeError("webagents.discover options must be an object.");
      }
      const page = await ensureSessionPage(session);
      const discovered = await discoverPageWebAgents(page, {
        refresh: untrustedField(options, "refresh") === true,
      });
      if (!discovered.manifest) {
        return {
          available: false,
          error: String(discovered.error || "WebAgents is unavailable.").slice(0, 500),
        };
      }
      const activeUrl = new URL(page.url());
      session.webAgentsAnnouncedOrigins.add(`${activeUrl.origin}${activeUrl.pathname}`);
      return publicWebAgentsManifest(discovered.manifest);
    });
    webagents.batch = realm.safeFunction(
      async (operationsValue, optionsValue: any = {}) => {
        let operations = operationsValue;
        let options = optionsValue;
        if (isObjectValue(operationsValue) && !Array.isArray(operationsValue)) {
          operations = untrustedField(operationsValue, "operations");
          options = operationsValue;
        }
        if (!isObjectValue(options) || Array.isArray(options)) {
          throw new TypeError("webagents.batch options must be an object.");
        }
        const page = await ensureSessionPage(session);
        const discovered = await discoverPageWebAgents(page, {
          refresh: untrustedField(options, "refresh") === true,
        });
        if (!discovered.manifest) {
          throw new Error(discovered.error || "This origin does not publish WebAgents.");
        }
        const activeUrl = new URL(page.url());
        session.webAgentsAnnouncedOrigins.add(`${activeUrl.origin}${activeUrl.pathname}`);
        const request = prepareWebAgentsBatch(
          discovered.manifest,
          operations,
          options,
        );
        const response = await pageSiteRequest(page, request.endpoint, {
          method: "POST",
          json: request.body,
          response: "json",
        });
        if (!response.ok) {
          const responseJson = "json" in response ? response.json : null;
          const detail = isObjectValue(responseJson)
            ? untrustedField(responseJson, "error")
            : "";
          const suffix = isString(detail) && detail.trim()
            ? ` Site error (untrusted): ${detail.trim().slice(0, 500)}`
            : "";
          throw new Error(`WebAgents workflow failed with HTTP ${response.status}.${suffix}`);
        }
        const effects = new Map(
          discovered.manifest.actions.map((action) => [action.name, action.effect]),
        );
        const hasEffects = request.body.operations.some(
          (operation) => effects.get(operation.action) !== "read",
        );
        let pageUpdated = false;
        if (hasEffects && untrustedField(options, "refresh") !== false) {
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.waitForLoadState("load", { timeout: 5_000 }).catch(() => {});
          await page.waitForTimeout(150);
          pageUpdated = true;
        }
        return {
          protocol: `webagents/${discovered.manifest.version}`,
          status: response.status,
          pageUpdated,
          result: "json" in response ? response.json : null,
          trust: "untrusted_external_data",
        };
      },
    );
    return webagents;
  }

  function buildScreenshot(session: WorkerSession, realm: WorkerRealm) {
    return realm.safeFunction(async (options: string | ScreenshotOptions) => {
      const settings = isString(options) ? { name: options } : options || {};
      const page = await ensureSessionPage(session);
      const kind = ["proof", "question", "debug"].includes(settings.kind)
        ? settings.kind
        : "debug";
      const type = settings.type === "jpeg" ? "jpeg" : "png";
      // Chromium infers the encoding from the file extension, so a name without
      // one (e.g. "home") would fail. Normalize to the requested type and also
      // pass `type` explicitly so the two can never disagree.
      let requested = settings.name || `${kind}.${type}`;
      if (!/\.(png|jpe?g)$/i.test(requested)) requested = `${requested}.${type}`;
      const fullPage = Boolean(settings.fullPage);
      let annotations;
      const annotateInResidentPage = Boolean(settings.annotate);
      if (settings.annotate) {
        annotations = annotateInResidentPage
          ? await addScreenshotAnnotations(page, fullPage)
          : 0;
      }
      let file;
      try {
        const shotOptions = { type, fullPage, animations: "disabled" };
        file = await captureScreenshot(
          page,
          session,
          requested,
          `${kind}.${type}`,
          type === "jpeg"
            ? { ...shotOptions, quality: Number(settings.quality) || 80 }
            : shotOptions,
        );
      } finally {
        if (annotateInResidentPage)
          await removeScreenshotAnnotations(page);
      }
      const artifact: ScreenshotArtifact = {
        kind,
        path: file,
        media: `MEDIA:${file}`,
      };
      if (annotations !== undefined) artifact.annotations = annotations;
      session.artifacts.push(artifact);
      if (kind === "question") session.awaitingAnswerSince = Date.now();
      return artifact;
    });
  }

  function buildSandbox(
    session: WorkerSession,
    consoleMessages: { level: string; text: string }[],
    execution: SandboxExecution,
  ) {
    const sandbox = Object.create(null);
    const context = vm.createContext(sandbox, {
      name: `betterwright-${session.id}`,
      codeGeneration: { strings: false, wasm: false },
    });
    const realm = createRealm(context, execution.pageEvents);
    const addConsole = (level) =>
      realm.safeFunction((...args) => {
        if (consoleMessages.length >= MAX_CONSOLE_MESSAGES) return;
        const joined = redactText(args.map(String).join(" "));
        consoleMessages.push({
          level,
          text:
            joined.length > MAX_CONSOLE_MESSAGE_CHARS
              ? `${joined.slice(0, MAX_CONSOLE_MESSAGE_CHARS)}[truncated]`
              : joined,
        });
        return undefined;
      });
    const consoleFacade = Object.create(null);
    for (const level of ["log", "info", "warn", "error"])
      consoleFacade[level] = addConsole(level);

    const getCurrentPage = () => {
      const current = session.pages.get(session.currentId);
      if (!current || current.isClosed())
        throw new Error("No active page; call openPage(url).");
      return wrap(current, realm);
    };
    const getPages = () =>
      [...session.pages.values()]
        .filter((page) => !page.isClosed())
        .map((page) => wrap(page, realm));

    sandbox.console = Object.freeze(consoleFacade);
    sandbox.context = wrap(getBrowserContext(), realm);
    sandbox.state = session.state;
    Object.assign(sandbox, createUrlGlobals(realm));
    sandbox.pages = realm.makePages(getPages);
    sandbox.openPage = realm.safeFunction(async (url = null, options: any = {}) => {
      if (getConfig().hostOwnedTarget) throw new Error("Open another tab through the host.");
      if (session.pages.size >= MAX_PAGES_PER_SESSION) {
        throw new Error(
          `Browser page limit (${MAX_PAGES_PER_SESSION}) reached for this session.`,
        );
      }
      const rawPage = await getBrowserContext().newPage();
      const page = adoptPage(rawPage, session.id);
      if (url) {
        assertModelNavigationUrl(url);
        await page.goto(String(url), navigationOptions(options));
      }
      return wrap(page, realm);
    });
    sandbox.usePage = realm.safeFunction(async (selector) => {
      assertPageHandle(selector, "usePage");
      const entries = [...session.pages.entries()].filter(
        ([, page]) => !page.isClosed(),
      );
      const entry = findPageEntry(entries, selector);
      if (!entry)
        throw new Error(
          `Unknown page ${describePageHandle(selector)}; available: ${entries.map(([id]) => id).join(", ")}`,
        );
      session.currentId = entry[0];
      notifyLiveViewPreferred();
      return wrap(entry[1], realm);
    });
    sandbox.closePage = realm.safeFunction(async (selector) => {
      if (getConfig().hostOwnedTarget) throw new Error("Close this tab through the host.");
      const target = selector === undefined ? session.currentId : selector;
      assertPageHandle(target, "closePage");
      const entries = [...session.pages.entries()];
      const entry = findPageEntry(entries, target);
      if (!entry) return { closed: false };
      await stopPageRecording(entry[1]);
      await entry[1].close();
      return { closed: true, pageId: entry[0] };
    });
    sandbox.snapshot = realm.safeFunction(async (options) => {
      const page = await ensureSessionPage(session);
      return snapshotPage(page, options);
    });
    sandbox.artifactPath = realm.safeFunction((requested) =>
      makeArtifactPath(session, requested),
    );
    const recording = Object.create(null);
    recording.start = realm.safeFunction((options) => startSessionRecording(session, options));
    recording.stop = realm.safeFunction(() => stopSessionRecording(session));
    recording.status = realm.safeFunction(() => sessionRecordingStatus(session));
    recording.restart = realm.safeFunction(async (options) => {
      await stopSessionRecording(session);
      return startSessionRecording(session, options);
    });
    sandbox.recording = Object.freeze(recording);
    sandbox.screenshot = buildScreenshot(session, realm);
    const dialogs = Object.create(null);
    dialogs.acceptNext = realm.safeFunction((promptText) => {
      session.nextDialog = { action: "accept", promptText };
      return { prepared: "accept" };
    });
    dialogs.dismissNext = realm.safeFunction(() => {
      session.nextDialog = { action: "dismiss" };
      return { prepared: "dismiss" };
    });
    const captcha = buildCaptcha(session, realm);
    const human = buildHuman(session, realm);
    const overlays = Object.create(null);
    overlays.dismiss = realm.safeFunction(async () => {
      const page = await ensureSessionPage(session);
      return dismissObstructiveOverlays(page);
    });
    const controls = Object.create(null);
    controls.inspect = realm.safeFunction(async () => {
      const page = await ensureSessionPage(session);
      return inspectControls(page);
    });
    controls.directory = realm.safeFunction(async (options) => {
      const page = await ensureSessionPage(session);
      return inspectActionDirectory(page, options);
    });
    controls.batch = realm.safeFunction(
      async (operationsValue, optionsValue: any = {}) => {
        let operations = operationsValue;
        let options = optionsValue;
        if (isObjectValue(operationsValue) && !Array.isArray(operationsValue)) {
          operations = untrustedField(operationsValue, "operations");
          options = operationsValue;
        }
        const page = await ensureSessionPage(session);
        return executeUIBatch(page, operations, options);
      },
    );
    const media = Object.create(null);
    media.inspect = realm.safeFunction(async () => {
      const page = await ensureSessionPage(session);
      return inspectMedia(page);
    });
    const site = buildSite(session, realm);
    const webmcp = Object.create(null);
    webmcp.tools = realm.safeFunction(async (options: any = {}) => {
      if (!isObjectValue(options) || Array.isArray(options)) {
        throw new TypeError("webmcp.tools options must be an object.");
      }
      const page = await ensureSessionPage(session);
      return listWebMCPTools(page, {
        newCDPSession: (target) => getBrowserContext().newCDPSession(target),
        timeout: untrustedField(options, "timeout"),
      });
    });
    webmcp.invoke = realm.safeFunction(
      async (name, input: any = {}, options: any = {}) => {
        const page = await ensureSessionPage(session);
        return invokeWebMCPTool(page, name, input, options, {
          newCDPSession: (target) => getBrowserContext().newCDPSession(target),
        });
      },
    );
    const webagents = buildWebAgents(session, realm);
    sandbox.dialogs = Object.freeze(dialogs);
    sandbox.captcha = Object.freeze(captcha);
    sandbox.human = Object.freeze(human);
    sandbox.overlays = Object.freeze(overlays);
    sandbox.controls = Object.freeze(controls);
    sandbox.media = Object.freeze(media);
    sandbox.site = Object.freeze(site);
    sandbox.webmcp = Object.freeze(webmcp);
    sandbox.webagents = Object.freeze(webagents);
    sandbox.credentials = buildCredentials(session, realm, execution);
    realm.installPage(getCurrentPage);
    return { context, realm, sandbox };
  }

  return buildSandbox;
}
