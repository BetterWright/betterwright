// Credential fill: the worker-side flow that fetches a secret from the vault
// and types it into the page without ever handing it to model code.
//
// Two callers share it — the host client's fillCredential /
// generateAndFillCredential RPCs and the model-callable `credentials.*` API
// built by `buildCredentials` — and both must produce identical behaviour: the
// same form detection, the same origin scoping, the same trusted human-shaped
// input, and the same redaction of every value on the way out. Keeping the
// whole path in one module is what makes that easy to audit (SECURITY.md).
//
// The worker owns the state this needs — the host RPC channel, the secret
// tracker, the redaction net, session pages and trusted input — so it hands
// those in as `deps`. Nothing here reaches into worker globals.

import crypto from "node:crypto";
import {
  assertRotationPreservesMatchMode,
  MAX_PENDING_CREDENTIAL_ORIGINS,
  pendingCredentialRecovery,
  validateCredentialMatchMode,
} from "./credential-constants.js";
import {
  CREDENTIAL_FRAME_PROBE_MS,
  collectCredentialFrameDetections,
  credentialProbeTimedOut,
  disposeCredentialFrameDetections,
  probePinnedCredentialOrigin,
  withProbeDeadline,
} from "./credential-target-scan.js";
import {
  isBoolean,
  isCallable,
  isString,
  type UntrustedValue,
  untrustedField,
} from "./untrusted-value.js";
import { httpOrigin } from "./vault-capture.js";

// Model-supplied credential specs, coerced field by field before any vault or
// page interaction sees them. A record `id` is forwarded to the vault adapter
// exactly as supplied, so it stays an opaque untrusted value.
interface VaultListQuery {
  text?: string;
  category?: string;
}

interface CredentialFieldTargets {
  usernameSelector?: string;
  passwordSelector?: string;
  currentPasswordSelector?: string;
  confirmPasswordSelector?: string;
  submitSelector?: string;
  submit?: boolean;
}

interface CredentialRecordSelector {
  id?: UntrustedValue;
  username?: string;
}

interface CredentialGenerateRequest {
  id?: string;
  username?: string;
  label?: string | null;
  length?: number;
  includeSymbols?: boolean;
  matchMode?: ReturnType<typeof validateCredentialMatchMode>;
}


function isObjectValue(value: UntrustedValue): value is UntrustedValue & object {
  return typeof value === "object" && value !== null;
}

interface CredentialFillDeps {
  /** Host RPC; credential calls go to the "vault" method. */
  rpc: (method: string, payload: UntrustedValue, executeId: string) => Promise<any>;
  /** Register a secret with the redaction net. */
  trackSecret: (value: UntrustedValue) => void;
  /** Register every secret-bearing field of a save/update payload. */
  trackCredentialWriteSecrets: (options: UntrustedValue) => void;
  redactDeep: (value: any) => any;
  /** The session's current page, opening one if none exists. */
  ensureSessionPage: (session: any) => Promise<any>;
  /** Trusted human-shaped click used for focus and submit. */
  humanClickTarget: (page: any, session: any, target: any, options: any) => Promise<any>;
  actionTimeoutMs: number;
}

export function createCredentialFill({
  rpc,
  trackSecret,
  trackCredentialWriteSecrets,
  redactDeep,
  ensureSessionPage,
  humanClickTarget,
  actionTimeoutMs: DEFAULT_ACTION_TIMEOUT_MS,
}: CredentialFillDeps) {
  async function currentOrigin(session) {
    const page = await ensureSessionPage(session);
    const origin = httpOrigin(page.url());
    if (!origin)
      throw new Error(
        "Credentials require the current page to have an http(s) origin.",
      );
    return { page, origin };
  }

  async function vaultCall(session, action, payload: any = {}): Promise<any> {
    const { origin } = await currentOrigin(session);
    return vaultCallAtOrigin(session, origin, action, payload);
  }

  async function vaultCallAtOrigin(
    session,
    origin,
    action,
    payload: any = {},
    key = null,
  ): Promise<any> {
    const response = await rpc(
      "vault",
      { action, origin, payload },
      key || session.execution.requestId || `active:${session.id}`,
    );
    if (response?.secret) trackSecret(response.secret);
    return response;
  }

  async function finalizePendingCredential(
    session,
    action,
    pendingId,
    trustedOrigin = "",
  ) {
    const trackedOrigin = session.pendingCredentialOrigins.get(pendingId) || "";
    const suppliedOrigin = trustedOrigin ? httpOrigin(trustedOrigin) : "";
    if (trustedOrigin && !suppliedOrigin) {
      const error = new Error(
        "The trusted pending credential origin is not a valid http(s) origin.",
      );
      error.code = "PENDING_ORIGIN_MISMATCH";
      throw error;
    }
    if (trackedOrigin && suppliedOrigin && trackedOrigin !== suppliedOrigin) {
      const error = new Error(
        "The pending credential origin does not match the generated credential.",
      );
      error.code = "PENDING_ORIGIN_MISMATCH";
      throw error;
    }
    // The session record is authoritative. The trusted host copy restores that
    // binding after a worker restart; only legacy/recovered untracked IDs fall
    // back to the current origin.
    const origin =
      trackedOrigin || suppliedOrigin || (await currentOrigin(session)).origin;
    const response = await vaultCallAtOrigin(session, origin, action, {
      pendingId,
    });
    session.pendingCredentialOrigins.delete(pendingId);
    if (session.execution.pendingRecovery?.pendingId === pendingId) {
      session.execution.pendingRecovery = null;
    }
    return response;
  }

  function recoveryFromError(error, session = null) {
    const recovery = error?.pendingCredential || session?.execution?.pendingRecovery;
    if (!recovery?.pendingId) return null;
    return redactDeep(recovery);
  }

  function buildCredentials(session, realm, execution) {
    const credentials = Object.create(null);
    const safeCredentialFunction = (operation) =>
      realm.safeTrackedFunction((...args) => {
        if (!execution.acceptingCredentialTasks) {
          const promise = Promise.reject(
            new Error(
              "Credential operations cannot outlive their browser execution.",
            ),
          );
          promise.catch(() => {});
          return { promise, markHandled() {} };
        }
        let task;
        try {
          task = Promise.resolve(operation(...args));
        } catch (error) {
          task = Promise.reject(error);
        }
        const record = {
          error: null,
          handled: false,
          promise: task,
          status: "pending",
        };
        task.then(
          () => {
            record.status = "fulfilled";
          },
          (error) => {
            record.error = error;
            record.status = "rejected";
          },
        );
        execution.credentialTasks.push(record);
        return {
          promise: task,
          markHandled() {
            record.handled = true;
          },
        };
      });
    // `list()` returns metadata for the current origin. Pass `{text}` to filter
    // and `{category}` to scope (e.g. "credit-card"); the vault backend applies
    // the filter and always strips secret values.
    credentials.list = safeCredentialFunction(async (query) => {
      const payload: VaultListQuery = {};
      if (isObjectValue(query)) {
        const text = untrustedField(query, "text");
        if (text != null) payload.text = String(text);
        const category = untrustedField(query, "category");
        if (category != null) payload.category = String(category);
      }
      const response = await vaultCall(session, "list", payload);
      return response.credentials || [];
    });
    credentials.listPending = safeCredentialFunction(async () => {
      const response = await vaultCall(session, "list-pending", {});
      return redactDeep(response.pendingCredentials || []);
    });
    credentials.save = safeCredentialFunction(async (options) => {
      // Login records need a password; other categories (identity, credit-card,
      // api-credential, secure-note) carry their own metadata instead.
      const category = options?.category ? String(options.category) : "login";
      if (category === "login" && !options?.password)
        throw new Error("credentials.save requires password for a login record.");
      // Non-login fields and notes can themselves be the secret. Track nested
      // values before the adapter sees them so every output path is covered even
      // when a custom adapter does not implement its optional redaction hook.
      trackCredentialWriteSecrets(options);
      const response = await vaultCall(session, "save", { ...options, category });
      const { secret: _secret, ...publicResult } = response;
      return publicResult;
    });
    credentials.update = safeCredentialFunction(async (options) => {
      trackCredentialWriteSecrets(options);
      const response = await vaultCall(session, "update", options || {});
      const { secret: _secret, ...publicResult } = response;
      return publicResult;
    });
    credentials.remove = safeCredentialFunction(async (options) =>
      vaultCall(session, "remove", options || {}),
    );
    // Model-callable fill: origin-scoped to the CURRENT page, the secret is
    // fetched and typed on the worker side and never returned, and every output
    // channel passes the redaction net. Reach matches
    // an unlocked password-manager extension (a field an extension filled is
    // equally visible to page JS), which is the accepted posture.
    const fillFieldSpec = (options) => {
      const fields: CredentialFieldTargets = {};
      for (const key of [
        "usernameSelector",
        "passwordSelector",
        "currentPasswordSelector",
        "confirmPasswordSelector",
        "submitSelector",
      ])
        if (options?.[key] != null) fields[key] = String(options[key]);
      if (options?.submit === true) fields.submit = true;
      return fields;
    };
    credentials.inspect = safeCredentialFunction(async (options) => {
      const page = await ensureSessionPage(session);
      const action = options?.generate === true ? "generate" : "fill";
      const detection = await detectCredentialTargets(page, action);
      try {
        return redactDeep(detection.metadata);
      } finally {
        await detection.dispose();
      }
    });
    credentials.fill = safeCredentialFunction(async (options) => {
      const record: CredentialRecordSelector = {};
      if (options?.id != null) record.id = String(options.id);
      if (options?.username != null) record.username = String(options.username);
      return redactDeep(
        await performCredentialFill(session, {
          action: "fill",
          record,
          fields: fillFieldSpec(options),
        }),
      );
    });
    credentials.generateAndFill = safeCredentialFunction(async (options) => {
      assertRotationPreservesMatchMode(options);
      const generate: CredentialGenerateRequest = {};
      if (options?.id != null) generate.id = String(options.id);
      if (options?.username != null) generate.username = String(options.username);
      if (Object.hasOwn(options || {}, "label"))
        generate.label = options.label == null ? null : String(options.label);
      if (options?.length != null) generate.length = Number(options.length);
      if (isBoolean(options?.includeSymbols))
        generate.includeSymbols = options.includeSymbols;
      if (options?.matchMode !== undefined)
        generate.matchMode = validateCredentialMatchMode(options.matchMode);
      return redactDeep(
        await performCredentialFill(session, {
          action: "generate",
          generate,
          fields: fillFieldSpec(options),
        }),
      );
    });
    for (const [method, action] of [
      ["commitGenerated", "commit"],
      ["discardGenerated", "discard"],
    ]) {
      credentials[method] = safeCredentialFunction(async (options) => {
        const pendingId = String(options?.pendingId ?? "").trim();
        if (!pendingId)
          throw new Error(`${method} requires a non-empty pendingId.`);
        const response = await finalizePendingCredential(session, action, pendingId);
        const { secret: _secret, ...publicResult } = response || {};
        return redactDeep(publicResult);
      });
    }
    return Object.freeze(credentials);
  }

  // Inspect visible, enabled credential controls without reading their values.
  // The classifier runs in the page so native form ownership and label
  // relationships stay intact; exact ElementHandles come back for trusted fill.
  async function detectCredentialTargetsInFrame(frame, requestedAction, anchor = null) {
    const lightweight = false;
    const marker = "";
    const anchorSelector = "";
    const bundle = await frame.evaluateHandle(
      ({ action, anchoredPassword, lightweight, marker, anchorSelector }) => {
        const mode = action === "generate" ? "generate" : "fill";
        const anchorElement = lightweight && anchorSelector
          ? document.querySelector(anchorSelector)
          : anchoredPassword;
        const normalize = (value) =>
          String(value || "")
            .replace(/\s+/g, " ")
            .trim()
            .toLowerCase();
        const autocompleteTokens = (element) =>
          normalize(element.getAttribute?.("autocomplete"))
            .split(" ")
            .filter(Boolean);
        const hasAutocomplete = (element, token) =>
          autocompleteTokens(element).includes(token);
        const roots: Array<Document | ShadowRoot> = [document];
        for (let index = 0; index < roots.length; index += 1) {
          for (const element of roots[index].querySelectorAll("*")) {
            if (element.shadowRoot) roots.push(element.shadowRoot);
          }
        }
        const queryAll = (selector) =>
          roots.flatMap((root) => Array.from(root.querySelectorAll(selector)));
        const labelsFor = (element) => {
          const labels = Array.from(element.labels || [])
            .map((label: Element) => label.textContent || "")
            .filter(Boolean);
          const root = element.getRootNode();
          const labelledBy = normalize(element.getAttribute?.("aria-labelledby"))
            .split(" ")
            .map((id) => root.getElementById?.(id)?.textContent || "")
            .filter(Boolean);
          return normalize([...labels, ...labelledBy].join(" "));
        };
        const semanticText = (element) =>
          normalize(
            [
              element.getAttribute?.("name"),
              element.getAttribute?.("id"),
              element.getAttribute?.("placeholder"),
              element.getAttribute?.("aria-label"),
              element.getAttribute?.("title"),
              labelsFor(element),
            ]
              .filter(Boolean)
              .join(" "),
          );
        const visibleAndEnabled = (element) => {
          if (!(element instanceof HTMLElement)) return false;
          if (
            element.hidden ||
            element.closest("[inert]") ||
            element.matches(":disabled") ||
            element.getAttribute("aria-disabled") === "true" ||
            ("readOnly" in element && element.readOnly)
          )
            return false;
          const style = getComputedStyle(element);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse"
          )
            return false;
          const rect = element.getBoundingClientRect();
          return (
            (lightweight || element.getClientRects().length > 0) &&
            rect.width > 0 &&
            rect.height > 0
          );
        };
        const order = new Map(
          queryAll("input, button, [role='button']").map((element, index) => [
            element,
            index,
          ]),
        );
        const elementOrder = (element) => order.get(element) ?? Number.MAX_SAFE_INTEGER;
        const passwordInputs = queryAll("input[type='password']").filter(
          visibleAndEnabled,
        );
        const textInputs = queryAll("input").filter(
          (element) =>
            visibleAndEnabled(element) &&
            ["", "email", "text"].includes(normalize(element.getAttribute("type"))),
        );

        const CONFIRM_RE =
          /\b(confirm|confirmation|repeat|retype|re-enter|verify|verification|again|matching)\b/;
        const CURRENT_PASSWORD_RE = /\bcurrent\b.*\bpass(word|code)?\b/;
        const NEW_PASSWORD_RE =
          /\b(new|create|choose|set)\b.*\bpass(word|code)?\b|\bpass(word|code)?\b.*\b(new|create|choose|set)\b/;
        const USERNAME_RE = /\b(user(name)?|email|e-mail|login|account|member)\b/;
        const IRRELEVANT_USER_RE =
          /\b(search|coupon|promo|one.?time|otp|code|phone|address|card|company|security|answer|display.?name|full.?name)\b/;
        const SIGNUP_RE =
          /\b(sign.?up|register|create account|join|new password|confirm password|reset password|change password)\b/;
        const LOGIN_RE = /\b(log.?in|sign.?in|current password|continue)\b/;

        const nearestScope = (element) => {
          if (element.form) return element.form;
          const semantic = element.closest(
            "dialog, [role='dialog'], section, article, main",
          );
          if (semantic) return semantic;
          let parent = element.parentElement;
          while (parent && parent !== document.body) {
            if (
              parent.querySelector(
                "button, input[type='submit'], input[type='image'], [role='button']",
              )
            )
              return parent;
            parent = parent.parentElement;
          }
          const root = element.getRootNode();
          return root instanceof ShadowRoot ? root : document.body;
        };
        const grouped = new Map();
        const candidates =
          anchorElement instanceof Element ? [anchorElement] : passwordInputs;
        for (const password of candidates) {
          const scope = nearestScope(password);
          if (!grouped.has(scope)) grouped.set(scope, []);
          grouped.get(scope).push(password);
        }

        const belongsToScope = (element, scope) => {
          if (scope instanceof HTMLFormElement) {
            if ("form" in element) return element.form === scope;
            return scope.contains(element);
          }
          return !element.form && scope.contains(element);
        };
        const fieldMetadata = (element) => {
          if (!(element instanceof Element)) return null;
          // SAFETY: `form` is read as an optional field — form-associated HTML
          // controls expose their owner HTMLFormElement (or null) there, and any
          // other candidate reads undefined, which the truthiness check treats
          // as no owning form.
          const ownerForm = (element as { form?: HTMLFormElement | null }).form;
          return {
            tag: element.tagName.toLowerCase(),
            type: normalize(element.getAttribute("type")) || null,
            autocomplete: normalize(element.getAttribute("autocomplete")) || null,
            name: element.getAttribute("name") || null,
            label: labelsFor(element) || element.getAttribute("aria-label") || null,
            formIndex: ownerForm
              ? Array.from(document.forms).indexOf(ownerForm)
              : null,
          };
        };
        const usernameFor = (scope, password) => {
          const scored = textInputs
            .filter((element) => belongsToScope(element, scope))
            .map((element) => {
              const text = semanticText(element);
              const tokens = autocompleteTokens(element);
              const type = normalize(element.getAttribute("type"));
              let score = 100;
              let credentialSemantic = false;
              if (tokens.includes("username")) {
                score += 1_000;
                credentialSemantic = true;
              } else if (tokens.includes("email")) {
                score += 800;
                credentialSemantic = true;
              } else if (tokens.includes("one-time-code")) score -= 2_000;
              if (type === "email") {
                score += 650;
                credentialSemantic = true;
              }
              if (USERNAME_RE.test(text)) {
                score += 500;
                credentialSemantic = true;
              }
              if (IRRELEVANT_USER_RE.test(text)) score -= 1_200;
              if (elementOrder(element) < elementOrder(password)) score += 80;
              score -= Math.min(
                Math.abs(elementOrder(element) - elementOrder(password)),
                80,
              );
              return { credentialSemantic, element, score };
            })
            .filter(({ credentialSemantic, score }) => credentialSemantic && score > 0)
            .sort(
              (left, right) =>
                right.score - left.score ||
                elementOrder(left.element) - elementOrder(right.element),
            );
          return scored[0]?.element || null;
        };
        const submitFor = (scope, password) => {
          const controls = queryAll(
            "button, input[type='submit'], input[type='image'], [role='button']",
          )
            .filter(visibleAndEnabled)
            .filter((element) => belongsToScope(element, scope))
            .map((element) => {
              const text = normalize(
                [
                  element.textContent,
                  element.getAttribute("value"),
                  element.getAttribute("aria-label"),
                  element.getAttribute("name"),
                  element.getAttribute("title"),
                ]
                  .filter(Boolean)
                  .join(" "),
              );
              let score = 0;
              if (element.matches("input[type='submit'], input[type='image']"))
                score += 1_000;
              if (element instanceof HTMLButtonElement && element.type === "submit")
                score += 900;
              if (mode === "generate") {
                if (
                  /\b(sign.?up|register|create|save|update|change|reset|continue|submit)\b/.test(
                    text,
                  )
                )
                  score += 500;
              } else if (/\b(log.?in|sign.?in|continue|next|submit)\b/.test(text)) {
                score += 500;
              }
              if (/\b(cancel|back|forgot|show|reveal)\b/.test(text)) score -= 1_500;
              score -= Math.min(
                Math.abs(elementOrder(element) - elementOrder(password)),
                100,
              );
              return { element, score };
            })
            .filter(({ score }) => score > 0)
            .sort(
              (left, right) =>
                right.score - left.score ||
                elementOrder(left.element) - elementOrder(right.element),
            );
          if (!controls.length) return { element: null, ambiguous: false };
          if (controls.length > 1 && controls[0].score === controls[1].score)
            return { element: null, ambiguous: true };
          return { element: controls[0].element, ambiguous: false };
        };

        const viable = [];
        const issues = [];
        for (const [scope, passwords] of grouped) {
          const ordered = [...passwords].sort(
            (left, right) => elementOrder(left) - elementOrder(right),
          );
          const scopeText = normalize(scope.textContent).slice(0, 4_000);
          const signupLike = SIGNUP_RE.test(scopeText);
          const loginLike = LOGIN_RE.test(scopeText);
          const isConfirm = (element) => CONFIRM_RE.test(semanticText(element));
          const isCurrent = (element) =>
            hasAutocomplete(element, "current-password") ||
            CURRENT_PASSWORD_RE.test(semanticText(element));
          const isNew = (element) =>
            hasAutocomplete(element, "new-password") ||
            NEW_PASSWORD_RE.test(semanticText(element));
          let password = null;
          let confirmPassword = null;
          let currentPassword = null;
          const current = ordered.filter(isCurrent);
          if (current.length > 1) {
            issues.push("multiple current-password fields");
            continue;
          }

          if (anchorElement instanceof Element) {
            password = anchorElement;
          } else if (mode === "generate") {
            currentPassword = current[0] || null;
            const autocompleteNew = ordered.filter((element) =>
              hasAutocomplete(element, "new-password"),
            );
            const semanticallyNew = ordered.filter(
              (element) => isNew(element) || isConfirm(element),
            );
            let pool = autocompleteNew;
            if (!pool.length && semanticallyNew.length)
              pool = ordered.filter((element) => !isCurrent(element));
            if (!pool.length && (signupLike || ordered.length > 1))
              pool = ordered.filter((element) => !isCurrent(element));
            if (!pool.length) continue;

            const explicitConfirm = pool.filter(isConfirm);
            if (explicitConfirm.length > 1) {
              issues.push("multiple confirmation password fields");
              continue;
            }
            confirmPassword = explicitConfirm[0] || null;
            const primary = pool.filter((element) => element !== confirmPassword);
            if (!primary.length) {
              password = pool[0];
              confirmPassword = pool[1] || null;
            } else {
              password = primary[0];
              if (primary.length > 1 && pool.length > 2) {
                issues.push("multiple new-password fields");
                continue;
              }
              if (!confirmPassword && pool.length === 2)
                confirmPassword = pool.find((element) => element !== password) || null;
            }
          } else {
            if (current.length === 1) {
              password = current[0];
            } else {
              const existing = ordered.filter(
                (element) => !isNew(element) && !isConfirm(element),
              );
              if (signupLike && !loginLike) continue;
              if (existing.length > 1) {
                issues.push("multiple password fields without current-password semantics");
                continue;
              }
              password = existing[0] || null;
            }
          }
          if (!password) continue;
          const submit = submitFor(scope, password);
          viable.push({
            password,
            confirmPassword,
            currentPassword,
            username: usernameFor(scope, password),
            submit: submit.element,
            submitAmbiguous: submit.ambiguous,
          });
        }

        if (viable.length !== 1 || issues.length) {
          const ambiguous = viable.length > 1 || issues.length > 0;
          return {
            metadata: {
              action: mode,
              status: ambiguous ? "ambiguous" : "not-found",
              reason: ambiguous
                ? issues[0] || "multiple visible credential forms match"
                : mode === "generate"
                  ? "no visible enabled new-password field was found"
                  : "no visible enabled current-password or login password field was found",
              candidateForms: viable.length,
              fields: {
                username: null,
                currentPassword: null,
                password: null,
                confirmPassword: null,
                submit: null,
              },
            },
            username: null,
            currentPassword: null,
            password: null,
            confirmPassword: null,
            submit: null,
          };
        }

        const selected = viable[0];
        const metadata = {
            action: mode,
            status: "ready",
            reason: selected.submitAmbiguous
              ? "credential fields are ready, but multiple submit controls match"
              : null,
            candidateForms: 1,
            fields: {
              username: fieldMetadata(selected.username),
              currentPassword: fieldMetadata(selected.currentPassword),
              password: fieldMetadata(selected.password),
              confirmPassword: fieldMetadata(selected.confirmPassword),
              submit: fieldMetadata(selected.submit),
            },
          };
        if (lightweight) {
          type TaggedSelectors = {
            metadata: typeof metadata;
            username?: string | null;
            currentPassword?: string | null;
            password?: string | null;
            confirmPassword?: string | null;
            submit?: string | null;
            submitAmbiguous?: null;
          };
          const tagged: TaggedSelectors = { metadata };
          for (const [name, element] of Object.entries(selected)) {
            if (!(element instanceof Element)) {
              tagged[name] = null;
              continue;
            }
            const token = `${marker}-${name}`;
            element.setAttribute("data-betterwright-credential", token);
            tagged[name] = `[data-betterwright-credential="${token}"]`;
          }
          return tagged;
        }
        return {
          metadata,
          username: selected.username,
          currentPassword: selected.currentPassword,
          password: selected.password,
          confirmPassword: selected.confirmPassword,
          submit: selected.submit,
        };
      },
      {
        action: requestedAction,
        anchoredPassword: lightweight ? null : anchor,
        lightweight,
        marker,
        anchorSelector,
      },
    );
    if (lightweight) {
      let serialized;
      try {
        serialized = await bundle.jsonValue();
      } finally {
        await bundle.dispose().catch(() => {});
      }
      const target = (name) => {
        const selector = untrustedField(serialized, name);
        return isString(selector) ? frame.locator(selector).first() : null;
      };
      let disposed = false;
      return {
        metadata: serialized?.metadata,
        frame,
        username: target("username"),
        currentPassword: target("currentPassword"),
        password: target("password"),
        confirmPassword: target("confirmPassword"),
        submit: target("submit"),
        async dispose() {
          if (disposed) return;
          disposed = true;
          await frame.evaluate((ownedMarker) => {
            for (const element of document.querySelectorAll(
              '[data-betterwright-credential]',
            )) {
              if (
                String(element.getAttribute("data-betterwright-credential") || "")
                  .startsWith(`${ownedMarker}-`)
              ) {
                element.removeAttribute("data-betterwright-credential");
              }
            }
          }, marker).catch(() => {});
        },
      };
    }
    const properties = await bundle.getProperties();
    const metadata = await properties.get("metadata").jsonValue();
    const propertyHandles = [...properties.values()];
    let disposed = false;
    return {
      metadata,
      frame,
      username: properties.get("username")?.asElement() || null,
      currentPassword: properties.get("currentPassword")?.asElement() || null,
      password: properties.get("password")?.asElement() || null,
      confirmPassword: properties.get("confirmPassword")?.asElement() || null,
      submit: properties.get("submit")?.asElement() || null,
      async dispose() {
        if (disposed) return;
        disposed = true;
        await Promise.all(
          propertyHandles.map((handle) => handle.dispose().catch(() => {})),
        );
        await bundle.dispose().catch(() => {});
      },
    };
  }

  async function credentialOriginForFrame(frame) {
    let ancestor = frame;
    while (ancestor.parentFrame()) {
      let frameElement = null;
      try {
        frameElement = await ancestor.frameElement();
        const sandbox = await frameElement.getAttribute("sandbox");
        if (
          sandbox != null &&
          !String(sandbox)
            .toLowerCase()
            .split(/\s+/)
            .includes("allow-same-origin")
        )
          return "";
      } catch {
        return "";
      } finally {
        await frameElement?.dispose().catch(() => {});
      }
      ancestor = ancestor.parentFrame();
    }

    let current = frame;
    while (current) {
      const origin = httpOrigin(current.url());
      if (origin) return origin;
      const url = String(current.url() || "");
      if (!["about:blank", "about:srcdoc"].includes(url)) return "";
      const parent = current.parentFrame();
      if (!parent) return "";
      current = parent;
    }
    return "";
  }

  function emptyCredentialDetection(metadata) {
    return {
      metadata,
      frame: null,
      origin: "",
      username: null,
      currentPassword: null,
      password: null,
      confirmPassword: null,
      submit: null,
      async dispose() {},
    };
  }

  async function detectCredentialTargets(page, requestedAction, anchor = null) {
    if (anchor) {
      const frame = await anchor.ownerFrame();
      if (!frame)
        return emptyCredentialDetection({
          action: requestedAction,
          status: "not-found",
          reason: "the explicit credential target is detached",
          candidateForms: 0,
          candidateFrames: 0,
          fields: {},
        });
      // Same deadline as the frame scan below: an anchored probe rides on the
      // same never-settling evaluate when its frame is wedged.
      const detection = await withProbeDeadline(
        detectCredentialTargetsInFrame(frame, requestedAction, anchor),
        CREDENTIAL_FRAME_PROBE_MS,
        (late) => late?.dispose?.().catch?.(() => {}),
      );
      if (credentialProbeTimedOut(detection))
        return emptyCredentialDetection({
          action: requestedAction,
          status: "not-found",
          reason:
            "the explicit credential target's frame did not respond in time (still loading or blocked) — let the page settle and retry",
          candidateForms: 0,
          candidateFrames: 0,
          unresponsiveFrames: 1,
          fields: {},
        });
      const origin = await withProbeDeadline(
        credentialOriginForFrame(frame),
        CREDENTIAL_FRAME_PROBE_MS,
      );
      detection.origin = credentialProbeTimedOut(origin) ? "" : origin;
      detection.metadata = {
        ...detection.metadata,
        candidateFrames: detection.metadata.status === "ready" ? 1 : 0,
        frameOrigin: detection.origin || null,
        frameUrl: frame.url(),
      };
      return detection;
    }

    const { detections, unresponsive } = await collectCredentialFrameDetections({
      frames: page.frames(),
      requestedAction,
      originForFrame: credentialOriginForFrame,
      detectInFrame: detectCredentialTargetsInFrame,
    });

    const ambiguous = detections.filter(
      ({ metadata }) => metadata.status === "ambiguous",
    );
    const viable = detections.filter(({ metadata }) => metadata.status === "ready");
    if (ambiguous.length || viable.length !== 1) {
      const status = ambiguous.length || viable.length > 1 ? "ambiguous" : "not-found";
      const candidateForms = detections.reduce(
        (total, { metadata }) => total + Number(metadata.candidateForms || 0),
        0,
      );
      // A frame that never answered may well be the one holding the form, so say
      // so instead of reporting a clean "no password field" the caller would take
      // at face value. Waiting for the page to settle is the fix, not a retry.
      const stalled = unresponsive.length
        ? `; ${unresponsive.length} frame${unresponsive.length === 1 ? "" : "s"} did not respond in time (still loading or blocked) — let the page settle, stop or reduce live page activity, or retry from a lightweight same-origin page; pass explicit selectors when the form itself is ambiguous`
        : "";
      const reason =
        (ambiguous[0]?.metadata.reason ||
          (viable.length > 1
            ? "multiple frames contain visible credential forms"
            : requestedAction === "generate"
              ? "no visible enabled new-password field was found in any frame"
              : "no visible enabled current-password or login password field was found in any frame")) +
        stalled;
      await disposeCredentialFrameDetections(detections);
      return emptyCredentialDetection({
        action: requestedAction === "generate" ? "generate" : "fill",
        status,
        reason,
        candidateForms,
        candidateFrames: ambiguous.length + viable.length,
        unresponsiveFrames: unresponsive.length,
        fields: {
          username: null,
          currentPassword: null,
          password: null,
          confirmPassword: null,
          submit: null,
        },
      });
    }

    const selected = viable[0];
    await disposeCredentialFrameDetections(
      detections.filter((detection) => detection !== selected),
    );
    selected.metadata = {
      ...selected.metadata,
      candidateFrames: 1,
      frameOrigin: selected.origin,
      frameUrl: selected.frame.url(),
    };
    return selected;
  }

  // Type a value into one field using a trusted human-shaped focus click followed
  // by an exact fill. The click emits isTrusted pointer events (which anti-bot and
  // password-manager UIs require); fill then clears the field and sets the precise
  // value, dispatching an `input` event so React-controlled and match-validated
  // forms observe the change.
  async function fillCredentialField(page, frame, session, target, value) {
    const explicit = isString(target) ? target.trim() : "";
    const locator = explicit ? frame.locator(explicit).first() : target;
    if (!locator) throw new Error("A credential field target is required to fill.");
    if (isCallable(untrustedField(locator, "waitFor"))) {
      await locator.waitFor({ state: "visible", timeout: DEFAULT_ACTION_TIMEOUT_MS });
    } else {
      await locator.waitForElementState?.("visible", {
        timeout: DEFAULT_ACTION_TIMEOUT_MS,
      });
    }
    try {
      await humanClickTarget(page, session, locator, {
        timeout: DEFAULT_ACTION_TIMEOUT_MS,
        inputLike: true,
      });
    } catch {
      await locator.focus({ timeout: DEFAULT_ACTION_TIMEOUT_MS }).catch(() => {});
    }
    await locator.fill(String(value), { timeout: DEFAULT_ACTION_TIMEOUT_MS });
    return locator;
  }

  async function resolveExplicitCredentialTarget(scope, selector, label) {
    try {
      const handle = await scope.locator(selector).first().elementHandle({
        timeout: DEFAULT_ACTION_TIMEOUT_MS,
      });
      if (!handle) throw new Error("target was not found");
      return handle;
    } catch (error) {
      throw new Error(
        `The explicit credential ${label} target could not be resolved: ${String(
          error?.message || error,
        )}`,
      );
    }
  }

  async function pinnedCredentialOrigin(frame, handles) {
    if (!frame || frame.isDetached()) {
      throw new Error("The explicit credential target frame is detached.");
    }
    const inspectDocument = async () => {
      try {
        return await frame.evaluate((elements) => {
          if (
            !elements.length ||
            new Set(elements).size !== elements.length ||
            elements.some(
              (element) =>
                !(element instanceof Element) ||
                !element.isConnected ||
                element.ownerDocument !== document,
            )
          ) {
            return null;
          }
          return document.location.href;
        }, handles);
      } catch {
        return null;
      }
    };

    const probe: any = await probePinnedCredentialOrigin({
      inspectDocument,
      originForFrame: () => credentialOriginForFrame(frame),
    });
    if (probe.timedOut) {
      throw new Error(
        `The explicit credential target frame did not respond in time during ${probe.phase} ` +
          "(still loading or blocked) — let the page settle, stop or reduce live page activity, " +
          "or retry from a lightweight same-origin page.",
      );
    }
    const { documentUrlBefore, documentUrlAfter, origin } = probe;
    if (documentUrlBefore == null) {
      throw new Error(
        "The explicit credential targets became detached or their document changed before vault access.",
      );
    }
    const documentOriginBefore = httpOrigin(documentUrlBefore);
    const documentOriginAfter = httpOrigin(documentUrlAfter);
    if (
      documentUrlAfter == null ||
      !origin ||
      (documentOriginBefore && documentOriginBefore !== origin) ||
      (documentOriginAfter && documentOriginAfter !== origin)
    ) {
      throw new Error(
        "The explicit credential targets became detached or their document changed before vault access.",
      );
    }
    return origin;
  }

  async function prepareCredentialTargets(page, action, fields) {
    const selectors = {
      username: String(fields.usernameSelector || "").trim(),
      password: String(fields.passwordSelector || "").trim(),
      currentPassword: String(fields.currentPasswordSelector || "").trim(),
      confirmPassword: String(fields.confirmPasswordSelector || "").trim(),
      submit: String(fields.submitSelector || "").trim(),
    };
    const explicit = {
      username: null,
      password: null,
      currentPassword: null,
      confirmPassword: null,
      submit: null,
    };
    const explicitHandles = [];
    let detection = null;
    let targetFrame = page.mainFrame();
    const retain = (name, handle) => {
      explicit[name] = handle;
      explicitHandles.push(handle);
    };
    const dispose = async () => {
      await Promise.all([
        detection?.dispose(),
        ...explicitHandles.map(async (handle) => {
          await handle.dispose?.().catch(() => {});
        }),
      ]);
    };

    try {
      if (selectors.currentPassword && action !== "generate") {
        throw new Error(
          "currentPasswordSelector is only available when generating a password for rotation.",
        );
      }
      if (selectors.password) {
        retain(
          "password",
          await resolveExplicitCredentialTarget(
            page,
            selectors.password,
            "password",
          ),
        );
        targetFrame = await explicit.password.ownerFrame();
        if (!targetFrame) {
          throw new Error("The explicit credential password target is detached.");
        }
      }

      if (!selectors.password) {
        detection = await detectCredentialTargets(page, action);
      } else if (fields.submit === true && !selectors.submit) {
        detection = await detectCredentialTargets(page, action, explicit.password);
      }
      if (detection && detection.metadata.status !== "ready") {
        const { status, reason } = detection.metadata;
        throw new Error(`credential form ${status}: ${reason}. Use explicit targets.`);
      }
      if (!selectors.password && !detection?.password) {
        throw new Error("credential form detection found no password field.");
      }
      if (fields.submit === true && !selectors.submit && !detection?.submit) {
        const reason = detection?.metadata?.reason || "no submit control was found";
        throw new Error(`credential form submit detection failed: ${reason}.`);
      }
      if (detection?.frame) targetFrame = detection.frame;

      for (const [name, label] of [
        ["username", "username"],
        ["currentPassword", "current password"],
        ["confirmPassword", "confirmation password"],
        ["submit", "submit"],
      ]) {
        if (!selectors[name]) continue;
        retain(
          name,
          await resolveExplicitCredentialTarget(
            targetFrame,
            selectors[name],
            label,
          ),
        );
      }

      const pinnedHandles = [
        explicit.username || detection?.username,
        explicit.currentPassword || detection?.currentPassword,
        explicit.password || detection?.password,
        explicit.confirmPassword || detection?.confirmPassword,
        explicit.submit || detection?.submit,
      ].filter(Boolean);
      const origin = await pinnedCredentialOrigin(targetFrame, pinnedHandles);
      return {
        detection,
        dispose,
        explicit,
        origin,
        selectors,
        targetFrame,
      };
    } catch (error) {
      await dispose();
      throw error;
    }
  }

  // Core credential fill: fetch the secret for the selected form frame's origin
  // RPC, type it with trusted human-shaped input, optionally submit, and return
  // only non-secret metadata. The secret value never leaves the worker. Shared by
  // the host client's fillCredential/generateAndFillCredential and the
  // model-callable credentials.fill/generateAndFill.
  async function performCredentialFill(
    session,
    spec,
    requestId = session.execution.requestId,
  ) {
    const fields = isObjectValue(spec.fields) ? spec.fields : {};
    const action = spec.action === "generate" ? "generate" : "fill";
    const page = await ensureSessionPage(session);
    const prepared = await prepareCredentialTargets(page, action, fields);
    const { detection, explicit, origin, selectors, targetFrame } = prepared;

    let recovery = null;
    try {
      let vaultPayload;
      let generateSpec = null;
      if (action === "generate") {
        generateSpec = isObjectValue(spec.generate) ? spec.generate : {};
        assertRotationPreservesMatchMode(generateSpec);
        const generateId = untrustedField(generateSpec, "id");
        const generateUsername = untrustedField(generateSpec, "username");
        vaultPayload = {
          length: Number(untrustedField(generateSpec, "length")) || 24,
          include_symbols: untrustedField(generateSpec, "includeSymbols") !== false,
          pendingId: `pending_${crypto.randomUUID()}`,
        };
        if (generateId != null) vaultPayload.id = generateId;
        if (isString(generateUsername))
          vaultPayload.username = generateUsername;
        if (Object.hasOwn(generateSpec, "label"))
          vaultPayload.label = untrustedField(generateSpec, "label");
        const generateMatchMode = untrustedField(generateSpec, "matchMode");
        if (generateMatchMode !== undefined)
          vaultPayload.matchMode = validateCredentialMatchMode(generateMatchMode);
      } else {
        const recordSpec = isObjectValue(spec.record) ? spec.record : {};
        vaultPayload = {};
        const recordId = untrustedField(recordSpec, "id");
        if (recordId != null) vaultPayload.id = recordId;
        const recordUsername = untrustedField(recordSpec, "username");
        if (recordUsername != null) vaultPayload.username = recordUsername;
      }

      let currentSecret = "";
      if (
        action === "generate" &&
        (explicit.currentPassword || detection?.currentPassword)
      ) {
        const currentPayload: CredentialRecordSelector = {};
        const rotateId = untrustedField(generateSpec, "id");
        if (rotateId != null) currentPayload.id = rotateId;
        else {
          const rotateUsername = untrustedField(generateSpec, "username");
          if (isString(rotateUsername)) currentPayload.username = rotateUsername;
        }
        const currentRecord = await vaultCallAtOrigin(
          session,
          origin,
          "fill",
          currentPayload,
          `credrotate:${session.id}`,
        );
        currentSecret =
          currentRecord?.secret == null ? "" : String(currentRecord.secret);
        if (!currentSecret)
          throw new Error(
            "The vault did not return the current credential required for rotation.",
          );
        trackSecret(currentSecret);
      }

      if (action === "generate") {
        if (session.execution.generationStarted) {
          throw new Error(
            "Only one credential may be generated per browser execution; " +
              "recover or finalize the first pending credential before generating another.",
          );
        }
        // Reserve immediately before the RPC. Calls that fail validation or form
        // detection can be corrected, while concurrent generate RPCs cannot race.
        session.execution.generationStarted = true;
      }
      const record = await vaultCallAtOrigin(
        session,
        origin,
        action,
        vaultPayload,
        action === "generate" && requestId
          ? String(requestId)
          : `credfill:${session.id}`,
      );
      if (action === "generate") {
        recovery = pendingCredentialRecovery(record, generateSpec, origin);
        if (recovery) session.execution.pendingRecovery = recovery;
        if (!recovery) {
          throw new Error(
            "The vault did not return the pendingId required to recover the generated credential.",
          );
        }
      }
      const secret = record?.secret == null ? "" : String(record.secret);
      if (!secret)
        throw new Error("The vault did not return a credential to fill for this origin.");
      trackSecret(secret);
      const pendingId =
        action === "generate" ? String(record?.pendingId ?? "").trim() : "";
      if (pendingId) {
        session.pendingCredentialOrigins.delete(pendingId);
        session.pendingCredentialOrigins.set(pendingId, origin);
        if (
          session.pendingCredentialOrigins.size > MAX_PENDING_CREDENTIAL_ORIGINS
        ) {
          session.pendingCredentialOrigins.delete(
            session.pendingCredentialOrigins.keys().next().value,
          );
        }
      }

      const filled = [];
      let lastLocator = null;
      const usernameTarget =
        explicit.username || (!selectors.password ? detection?.username : null);
      const currentPasswordTarget =
        action === "generate"
          ? explicit.currentPassword ||
            (!selectors.password ? detection?.currentPassword : null)
          : null;
      const passwordTarget = explicit.password || detection?.password;
      const confirmTarget =
        explicit.confirmPassword ||
        (action === "generate" && !selectors.password
          ? detection?.confirmPassword
          : null);
      if (usernameTarget && isString(record.username) && record.username) {
        lastLocator = await fillCredentialField(
          page,
          targetFrame,
          session,
          usernameTarget,
          record.username,
        );
        filled.push("username");
      }
      if (currentPasswordTarget) {
        lastLocator = await fillCredentialField(
          page,
          targetFrame,
          session,
          currentPasswordTarget,
          currentSecret,
        );
        filled.push("currentPassword");
      }
      lastLocator = await fillCredentialField(
        page,
        targetFrame,
        session,
        passwordTarget,
        secret,
      );
      filled.push("password");
      if (confirmTarget) {
        lastLocator = await fillCredentialField(
          page,
          targetFrame,
          session,
          confirmTarget,
          secret,
        );
        filled.push("confirmPassword");
      }
      // Fire blur so forms that validate the password/confirm match on blur (not
      // just on input) run their check before any submit.
      if (lastLocator) {
        await lastLocator.press("Tab", {
          timeout: CREDENTIAL_FRAME_PROBE_MS,
        }).catch(() => {});
      }

      let submitted = false;
      const submitTarget =
        explicit.submit ||
        (untrustedField(fields, "submit") === true ? detection?.submit : null);
      if (submitTarget) {
        await humanClickTarget(page, session, submitTarget, {
          timeout: DEFAULT_ACTION_TIMEOUT_MS,
          inputLike: false,
        });
        submitted = true;
      }

      const { secret: _secret, ...publicRecord } = record || {};
      return { ...publicRecord, filled, submitted };
    } catch (error) {
      if (recovery) {
        const failure =
          error instanceof Error ? error : new Error(String(error || "Credential fill failed."));
        failure.pendingCredential = recovery;
        throw failure;
      }
      throw error;
    } finally {
      await prepared.dispose();
    }
  }


  return {
    buildCredentials,
    finalizePendingCredential,
    performCredentialFill,
    recoveryFromError,
    vaultCall,
    vaultCallAtOrigin,
  };
}
