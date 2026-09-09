import { randomUUID } from "node:crypto";
import type { PrintToPDFOptions, WebContents } from "electron";
import type { ElectronHostOptions } from "../types/electron.js";
import { withRendererGuestFocus } from "./electron-focus.js";
import { betterwrightExpectedInputs } from "./electron-input.js";
import { BetterwrightKeyboardPolicy } from "./electron-keyboard-policy.js";
import { isBoolean, isNumber, isString, type UntrustedValue, untrustedField } from "./untrusted-value.js";

type Params = Record<string, UntrustedValue>;
const MAX_PDF_BYTES = 100 * 1024 * 1024; // Match the worker's artifact-size limit.
const PDF_READ_BYTES = 64 * 1024;

function pdfOptions(params: Params): PrintToPDFOptions {
  const options: PrintToPDFOptions = {};
  const booleans = ["landscape", "displayHeaderFooter", "printBackground", "preferCSSPageSize", "generateTaggedPDF", "generateDocumentOutline"];
  const strings = ["headerTemplate", "footerTemplate", "pageRanges"];
  const numbers = ["scale", "paperWidth", "paperHeight", "marginTop", "marginBottom", "marginLeft", "marginRight"];
  const allowed = new Set([...booleans, ...strings, ...numbers, "transferMode"]);
  for (const key of Object.keys(params)) {
    if (!allowed.has(key)) throw new Error("Unsupported PDF option.");
    if (params[key] === undefined) continue;
    if (booleans.includes(key)) {
      if (!isBoolean(params[key])) throw new Error("Invalid PDF option.");
      options[key] = params[key];
    } else if (strings.includes(key)) {
      if (!isString(params[key])) throw new Error("Invalid PDF option.");
      options[key] = params[key];
    } else if (numbers.includes(key)) {
      const value = params[key];
      if (!isNumber(value) || !Number.isFinite(value) ||
          (key === "scale" ? value < 0.1 || value > 2 : key.startsWith("paper") ? value <= 0 : value < 0))
        throw new Error("Invalid PDF dimension.");
    }
  }
  if (params.transferMode !== undefined && !["ReturnAsStream", "ReturnAsBase64"].includes(String(params.transferMode)))
    throw new Error("Unsupported PDF transfer mode.");
  // Both CDP and Electron printToPDF use inches, unlike Electron's print() API.
  options.pageSize = { width: Number(params.paperWidth ?? 8.5), height: Number(params.paperHeight ?? 11) };
  options.margins = {
    top: Number(params.marginTop ?? 0.4), bottom: Number(params.marginBottom ?? 0.4),
    left: Number(params.marginLeft ?? 0.4), right: Number(params.marginRight ?? 0.4),
  };
  options.scale = Number(params.scale ?? 1);
  return options;
}
let nativeInputQueue: Promise<void> = Promise.resolve();

function enqueueNativeInput(operation: () => Promise<UntrustedValue>): Promise<UntrustedValue> {
  const pending = nativeInputQueue.then(operation, operation);
  nativeInputQueue = pending.then(() => {}, () => {});
  return pending;
}
export interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Params;
  readonly sessionId?: string;
}

const PAGE_DOMAINS = new Set([
  "Accessibility",
  "Animation",
  "CSS",
  "DOM",
  "DOMSnapshot",
  "Emulation",
  "Fetch",
  "Input",
  "Inspector",
  "Log",
  "Network",
  "Overlay",
  "Page",
  "Performance",
  "Runtime",
  "Security",
  "WebMCP",
]);
const FORBIDDEN_METHODS = new Set([
  "Page.close",
  "Page.crash",
  "Page.setDownloadBehavior",
  "Network.getAllCookies",
  "Network.setCookie",
  "Network.setCookies",
  "Network.deleteCookies",
  "Network.clearBrowserCookies",
  "Network.clearBrowserCache",
  "Security.setIgnoreCertificateErrors",
  "Security.setOverrideCertificateErrors",
  "Security.handleCertificateError",
]);

function requireWebUrl(value: UntrustedValue): void {
  if (value === "about:blank") return;
  if (!isString(value)) throw new Error("Missing URL.");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Non-web URL denied.");
}

/** A browser-shaped connection whose only authority is one leased WebContents. */
export class BetterwrightCdpTarget {
  private readonly pageSession = randomUUID();
  private readonly browserSessions = new Set<string>();
  private readonly pageSessions = new Set<string>();
  private readonly childSessions = new Set<string>();
  private readonly pending = new Set<Promise<UntrustedValue>>();
  private readonly streams = new Map<string, string | undefined>();
  private readonly pdfStreams = new Map<string, { data: Buffer; offset: number }>();
  private pdfBytes = 0;
  private printingPdf = false;
  private revoked = false;
  private endLease!: () => void;
  private readonly leaseEnded = new Promise<void>((resolve) => {
    this.endLease = resolve;
  });
  private readonly keyboardPolicy = new BetterwrightKeyboardPolicy();
  private disposed = false;
  private disposal: Promise<void> | undefined;
  private attached = false;

  constructor(
    private readonly contents: WebContents,
    private readonly emit: (message: CdpMessage | Record<string, UntrustedValue>) => void,
    private readonly diagnostic?: (
      method: string,
      outcome: "received" | "completed" | "denied",
    ) => void,
    readonly targetId: string = randomUUID(),
    private readonly uploadFiles: ReadonlySet<string> = new Set(),
    private readonly backendSessionId?: string,
    private readonly cookieImport = false,
    private readonly expectAgentInput?: ElectronHostOptions["expectAgentInput"],
    private readonly onRevoked?: () => void,
  ) {
    if (contents.isDestroyed()) throw new Error("Browser target is unavailable.");
    if (!contents.debugger.isAttached()) contents.debugger.attach("1.3");
    contents.debugger.on("message", this.onMessage);
    contents.debugger.on("detach", this.onDetach);
  }

  private targetInfo() {
    return {
      targetId: this.targetId,
      type: "page",
      title: this.contents.getTitle(),
      url: this.contents.getURL(),
      attached: true,
      browserContextId: this.targetId,
      canAccessOpener: false,
    };
  }

  private readonly onDetach = () => {
    if (this.revoked) return;
    this.revoked = true;
    this.disposed = true;
    this.endLease();
    this.streams.clear();
    this.pdfStreams.clear();
    this.pdfBytes = 0;
    this.contents.debugger.removeListener("message", this.onMessage);
    this.contents.debugger.removeListener("detach", this.onDetach);
    try {
      for (const sessionId of this.pageSessions)
        this.emit({ method: "Target.detachedFromTarget", params: { sessionId, targetId: this.targetId } });
    } finally {
      this.onRevoked?.();
    }
  };

  private readonly onMessage = (
    _event: UntrustedValue,
    method: string,
    params: Params,
    sessionId?: string,
  ) => {
    if (this.disposed) return;
    this.diagnostic?.(method, "received");
    if (this.backendSessionId) {
      if (!sessionId && method === "Target.detachedFromTarget" && params.sessionId === this.backendSessionId) {
        this.onDetach();
        return;
      }
      if (sessionId === this.backendSessionId) sessionId = undefined;
      else if (!sessionId) return;
    }
    if (sessionId && !this.childSessions.has(sessionId)) return;
    if (method === "Target.attachedToTarget" && isString(params.sessionId)) {
      this.childSessions.add(params.sessionId);
    }
    if (method === "Target.detachedFromTarget" && isString(params.sessionId)) {
      this.childSessions.delete(params.sessionId);
    }
    if (sessionId) {
      this.emit({ method, params, sessionId });
    } else {
      for (const pageSession of this.pageSessions) {
        this.emit({ method, params, sessionId: pageSession });
      }
    }
  };

  async receive(message: CdpMessage): Promise<void> {
    if (!Number.isSafeInteger(message.id) || !isString(message.method)) return;
    const response = {
      id: message.id,
      sessionId: message.sessionId,
    };
    try {
      this.diagnostic?.(message.method, "received");
      const result = await this.command(message.method, message.params ?? {}, message.sessionId);
      this.diagnostic?.(message.method, "completed");
      if (!this.disposed) this.emit({ ...response, result });
    } catch {
      this.diagnostic?.(message.method, "denied");
      // CDP errors can echo expressions, headers and secrets. Keep the transport error fixed.
      this.emit({
        ...response,
        error: { code: -32000, message: "Browser command unavailable for this target lease." },
      });
    }
  }

  private send(method: string, params: Params, sessionId?: string): Promise<UntrustedValue> {
    if (this.disposed) return Promise.reject(new Error("Browser target lease ended."));
    const operation = Promise.race([
      this.contents.debugger.sendCommand(method, params, sessionId ?? this.backendSessionId).then(async (result) => {
        // Only handles issued by these authorized commands gain IO authority.
        const handle = method === "Network.loadNetworkResource"
          ? untrustedField(untrustedField(result, "resource"), "stream")
          : method === "Fetch.takeResponseBodyAsStream"
            ? untrustedField(result, "stream") : undefined;
        if (isString(handle) && handle) {
          const owner = sessionId ?? this.backendSessionId;
          if (this.disposed) {
            await this.contents.debugger.sendCommand("IO.close", { handle }, owner).catch(() => {});
          } else this.streams.set(handle, owner);
        }
        return result;
      }),
      this.leaseEnded.then(() => {
        throw new Error("Browser target lease ended.");
      }),
    ]);
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }

  private async printPdf(params: Params): Promise<UntrustedValue> {
    const options = pdfOptions(params);
    if (this.printingPdf || this.pdfStreams.size >= 16) throw new Error("PDF capacity exceeded.");
    this.printingPdf = true;
    const printing = Promise.resolve().then(() => {
      if (this.disposed || this.contents.isDestroyed()) throw new Error("Browser target lease ended.");
      return this.contents.printToPDF(options);
    }).then(data => {
      if (this.disposed) throw new Error("Browser target lease ended.");
      if (data.length > MAX_PDF_BYTES - this.pdfBytes) throw new Error("PDF capacity exceeded.");
      if (params.transferMode !== "ReturnAsStream") return { data: data.toString("base64") };
      const stream = `betterwright-pdf-${randomUUID()}`;
      this.pdfStreams.set(stream, { data, offset: 0 });
      this.pdfBytes += data.length;
      return { data: "", stream };
    }).finally(() => { this.printingPdf = false; });
    const operation = Promise.race([printing, this.leaseEnded.then(() => { throw new Error("Browser target lease ended."); })]);
    this.pending.add(operation);
    try { return await operation; }
    finally { this.pending.delete(operation); }
  }

  private async command(method: string, params: Params, sessionId?: string): Promise<UntrustedValue> {
    if (this.disposed || this.contents.isDestroyed())
      throw new Error("Browser target lease ended.");
    const root = !sessionId || this.browserSessions.has(sessionId);
    if (!root && !this.pageSessions.has(sessionId) && !this.childSessions.has(sessionId)) {
      throw new Error("Unknown target session.");
    }
    if (method === "Target.getTargetInfo") {
      if (params.targetId !== undefined && params.targetId !== this.targetId)
        throw new Error("Unknown target.");
      return { targetInfo: this.targetInfo() };
    }
    if (root) {
      if (method === "Browser.setDownloadBehavior" && params.behavior === "deny") return {};
      if (method === "Browser.getVersion") return this.send(method, {});
      if (method === "Target.getTargets") return { targetInfos: [this.targetInfo()] };
      if (method === "Target.getBrowserContexts") return { browserContextIds: [] };
      if (method === "Target.setDiscoverTargets") return {};
      if (method === "Target.setAutoAttach") {
        if (params.autoAttach && !this.attached) {
          this.attached = true;
          this.pageSessions.add(this.pageSession);
          this.emit({
            method: "Target.attachedToTarget",
            params: {
              sessionId: this.pageSession,
              targetInfo: this.targetInfo(),
              waitingForDebugger: false,
            },
          });
        }
        return {};
      }
      if (method === "Target.attachToBrowserTarget") {
        const id = randomUUID();
        this.browserSessions.add(id);
        return { sessionId: id };
      }
      if (method === "Target.attachToTarget" && params.targetId === this.targetId) {
        const id = randomUUID();
        this.pageSessions.add(id);
        return { sessionId: id };
      }
      if (method === "Target.detachFromTarget") {
        if (!isString(params.sessionId)) throw new Error("Missing session.");
        this.browserSessions.delete(params.sessionId);
        this.pageSessions.delete(params.sessionId);
        return {};
      }
      // Cookie reads are bounded to the leased page, never the partition's complete jar.
      if (method === "Storage.getCookies") {
        return this.send("Network.getCookies", { urls: [this.contents.getURL()] });
      }
      throw new Error("Browser-wide command denied.");
    }
    if (method === "Page.printToPDF") {
      if (this.childSessions.has(sessionId)) throw new Error("Printing a child target is unsupported.");
      return this.printPdf(params);
    }
    if (method === "IO.read" || method === "IO.close") {
      const pdf = isString(params.handle) ? this.pdfStreams.get(params.handle) : undefined;
      if (pdf) {
        if (this.childSessions.has(sessionId)) throw new Error("Unknown target stream.");
        if (method === "IO.close") {
          this.pdfStreams.delete(String(params.handle));
          this.pdfBytes -= pdf.data.length;
          return {};
        }
        const offset = params.offset ?? pdf.offset;
        const size = params.size ?? PDF_READ_BYTES;
        if (!isNumber(offset) || !Number.isSafeInteger(offset) || offset < 0 ||
            !isNumber(size) || !Number.isSafeInteger(size) || size <= 0)
          throw new Error("Invalid stream read.");
        const start = Math.min(offset, pdf.data.length);
        const end = Math.min(start + Math.min(size, PDF_READ_BYTES), pdf.data.length);
        pdf.offset = end;
        return { data: pdf.data.subarray(start, end).toString("base64"), base64Encoded: true, eof: end === pdf.data.length };
      }
      const owner = this.childSessions.has(sessionId) ? sessionId : this.backendSessionId;
      if (!isString(params.handle) || !this.streams.has(params.handle) || this.streams.get(params.handle) !== owner)
        throw new Error("Unknown target stream.");
      const result = await this.send(method, params, owner);
      if (method === "IO.close") this.streams.delete(params.handle);
      return result;
    }
    if (method === "Target.setAutoAttach") {
      return this.send(
        method,
        { ...params, flatten: true },
        this.childSessions.has(sessionId) ? sessionId : undefined,
      );
    }
    if (method === "Network.getCookies") {
      return this.send(
        method,
        { urls: [this.contents.getURL()] },
        this.childSessions.has(sessionId) ? sessionId : undefined,
      );
    }
    // Only a host-created import worker gets this grant. It never runs model code.
    if (this.cookieImport && ["Network.getAllCookies", "Network.setCookies"].includes(method)) {
      return this.send(method, params, this.childSessions.has(sessionId) ? sessionId : undefined);
    }
    if (FORBIDDEN_METHODS.has(method) || !PAGE_DOMAINS.has(method.split(".")[0])) {
      throw new Error("Command outside target scope.");
    }
    if (method === "DOM.setFileInputFiles") {
      // Only private staged files authorized by the host may cross this lease.
      // An empty list clears a file input without granting filesystem access.
      if (
        !Array.isArray(params.files) ||
        params.files.length > 512 ||
        params.files.some((file) => !isString(file) || !this.uploadFiles.has(file))
      ) {
        throw new Error("Upload not authorized for this target lease.");
      }
    }
    if (method === "Page.navigate" || method === "Network.loadNetworkResource") {
      requireWebUrl(params.url);
    }
    if (method === "Input.dispatchKeyEvent") this.keyboardPolicy.check(params);
    const nativeInput = method.startsWith("Input.") || method === "Page.bringToFront";
    const dispatch = async () => {
      if (this.disposed || this.contents.isDestroyed())
        throw new Error("Browser target lease ended.");
      const releases = betterwrightExpectedInputs(method, params).map((input) =>
        this.expectAgentInput?.(input),
      );
      // Resolve Electron only for native input; protocol-only tests need no Electron process.
      const webContents = nativeInput ? (await import("electron")).webContents : undefined;
      const previousFocus = webContents?.getFocusedWebContents() ?? null;
      try {
        // Native focus is shared across tabs; DOM focus alone cannot route text
        // to an offscreen preview. Keep focus and dispatch in the same lease.
        if (nativeInput && previousFocus !== this.contents) this.contents.focus();
        const send = async () => {
          if (
            method === "Input.dispatchMouseEvent" &&
            params.type === "mouseMoved" &&
            (params.buttons === undefined || params.buttons === 0) &&
            (params.button === undefined || params.button === "none") &&
            (params.pointerType === undefined || params.pointerType === "mouse") &&
            !this.childSessions.has(sessionId) &&
            this.contents.getType() !== "webview" &&
            isNumber(params.x) &&
            Number.isFinite(params.x) &&
            isNumber(params.y) &&
            Number.isFinite(params.y)
          ) {
            // Chromium can leave a move's CDP acknowledgement pending in a
            // hidden native view. Electron dispatches the same trusted hover
            // input without waiting for that visual acknowledgement.
            const zoom = this.contents.getZoomFactor();
            const modifiers = isNumber(params.modifiers) ? params.modifiers : 0;
            this.contents.sendInputEvent({
              type: "mouseMove",
              x: Math.round(params.x * zoom),
              y: Math.round(params.y * zoom),
              modifiers: (["alt", "control", "meta", "shift"] as const).filter(
                (_name, bit) => modifiers & (1 << bit),
              ),
            });
            return {};
          }
          return this.send(
            method,
            params,
            this.childSessions.has(sessionId) ? sessionId : undefined,
          );
        };
        if (!nativeInput) return await send();
        const focusedOperation = withRendererGuestFocus(this.contents, send);
        this.pending.add(focusedOperation);
        try {
          return await focusedOperation;
        } finally {
          this.pending.delete(focusedOperation);
        }
      } finally {
        try {
          if (
            previousFocus &&
            previousFocus !== this.contents &&
            !previousFocus.isDestroyed() &&
            webContents.getFocusedWebContents() === this.contents
          )
            previousFocus.focus();
        } finally {
          for (const release of releases) release?.();
        }
      }
    };
    return nativeInput ? enqueueNativeInput(dispatch) : dispatch();
  }

  dispose(cancel = true): Promise<void> {
    this.disposal ??= this.drain(cancel);
    return this.disposal;
  }

  private async drain(cancel: boolean): Promise<void> {
    this.disposed = true;
    this.pdfStreams.clear();
    this.pdfBytes = 0;
    this.contents.debugger.removeListener("message", this.onMessage);
    this.contents.debugger.removeListener("detach", this.onDetach);
    let leaseRevoked = this.revoked || this.contents.isDestroyed() || !this.contents.debugger.isAttached();
    if (!leaseRevoked) {
      await Promise.allSettled([
        ...Array.from(this.streams, ([handle, owner]) =>
          this.contents.debugger.sendCommand("IO.close", { handle }, owner)),
        ...(cancel
          ? [
              this.contents.debugger.sendCommand(
                "Runtime.terminateExecution",
                {},
                this.backendSessionId,
              ),
              // An idle renderer applies termination to its next script. Consume
              // that interrupt before releasing the lease, not in the next run.
              this.contents.debugger.sendCommand(
                "Runtime.evaluate",
                { expression: "void 0", silent: true },
                this.backendSessionId,
              ),
              this.contents.debugger.sendCommand("Page.stopLoading", {}, this.backendSessionId),
            ]
          : []),
        this.contents.debugger.sendCommand("Fetch.disable", {}, this.backendSessionId),
      ]);
      if (this.backendSessionId) {
        await this.contents.debugger
          .sendCommand("Target.detachFromTarget", { sessionId: this.backendSessionId })
          .then(
            () => {
              leaseRevoked = true;
            },
            () => {},
          );
      }
    }
    // Electron can leave awaited Runtime replies pending after a child-session
    // detach. Only settle them locally once teardown has acknowledged revocation.
    if (leaseRevoked || this.contents.isDestroyed() || !this.contents.debugger.isAttached())
      this.endLease();
    await Promise.allSettled([...this.pending]);
    this.streams.clear();
    // The manager, annotations and diagnostics share this debugger. Never detach or close it here.
  }
}
