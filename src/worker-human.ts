// Trusted input helpers shared by credentials and the snippet API.
import { captchaBounds } from "./captcha-runtime.js";
import { movePointer, pointInside, pressPointer, typedTextLanded } from "./human.js";
import { isBoolean, isCallable, isString, type UntrustedFunction, type UntrustedValue, untrustedField } from "./untrusted-value.js";

function isObjectValue(value: UntrustedValue): value is UntrustedValue & object {
  return typeof value === "object" && value !== null;
}

interface HumanInputDeps {
  unwrap: (value: UntrustedValue) => UntrustedValue;
  objectKind: (value: UntrustedValue) => string;
  actionTimeoutMs: number;
}

export function createHumanInput({ unwrap, objectKind, actionTimeoutMs: DEFAULT_ACTION_TIMEOUT_MS }: HumanInputDeps) {
  function unwrapHumanTarget(page, value) {
    if (isString(value)) return page.locator(value).first();
    const raw = unwrap(value);
    if (["Locator", "ElementHandle"].includes(objectKind(raw))) return raw;
    if (isObjectValue(value)) return captchaBounds(value, "target");
    throw new Error(
      "human target must be a selector, Locator, ElementHandle, or bounds object.",
    );
  }

  async function humanTargetBox(page, value, timeout = DEFAULT_ACTION_TIMEOUT_MS, inputLikeOverride) {
    const target = unwrapHumanTarget(page, value);
    if (!isCallable(untrustedField(target, "boundingBox"))) {
      return { target: null, box: target, inputLike: false };
    }
    await target.scrollIntoViewIfNeeded?.({ timeout });
    const box = await target.boundingBox({ timeout });
    if (!box) throw new Error("human target is not visible.");
    const inputLike =
      isBoolean(inputLikeOverride)
        ? inputLikeOverride
        : await target
            .evaluate(
              (element) =>
                ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName) ||
                element.isContentEditable,
            )
            .catch(() => false);
    return { target, box, inputLike };
  }

  async function humanClickTarget(page, session, value, options: any = {}) {
    const timeout = Math.max(1, Number(options?.timeout) || DEFAULT_ACTION_TIMEOUT_MS);
    const { target, box, inputLike } = await humanTargetBox(
      page,
      value,
      timeout,
      options?.inputLike,
    );
    const point = pointInside(box, inputLike);
    await movePointer(page.mouse, session.cursor, point, options);
    await pressPointer(page.mouse, inputLike);
    return target;
  }

  // Select a target's existing text so the next Backspace clears it. The
  // obvious `Control+A` chord is not reliable: the Chromium fork does not run
  // the select-all editing command for synthesized keyboard events (stock
  // Chromium does), so the chord silently left the old text in place and typed
  // text landed in front of it. Selecting through the element works on every
  // build and inside iframes, and raises the same `select` event a real
  // shortcut would; the chord remains only for bounds-style targets that have
  // no element to select through.
  async function selectAllForClear(page, target) {
    if (target && isCallable(untrustedField(target, "evaluate"))) {
      await target.evaluate((element) => {
        const isCallableValue = (value: UntrustedValue): value is UntrustedFunction =>
          typeof value === "function";
        if (isCallableValue(element.select)) {
          element.select();
          return;
        }
        if (element.isContentEditable) {
          const selection = element.ownerDocument.defaultView?.getSelection();
          if (!selection) return;
          const range = element.ownerDocument.createRange();
          range.selectNodeContents(element);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      });
      return;
    }
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  }

  async function readTypedFieldText(target) {
    if (!target || !isCallable(untrustedField(target, "evaluate"))) return null;
    return target.evaluate((element) => {
      if (
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement
      ) {
        return String(element.value ?? "");
      }
      return String(element.innerText ?? element.textContent ?? "");
    });
  }

  async function restoreTypedFieldText(target, text) {
    const value = String(text ?? "");
    if (!target) return;
    if (isCallable(untrustedField(target, "evaluate"))) {
      await target.evaluate((element, next) => {
        const isCallableValue = (value: UntrustedValue): value is UntrustedFunction =>
          typeof value === "function";
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        ) {
          element.value = next;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          return;
        }
        if (!element.isContentEditable) return;
        if (isCallableValue(element.focus)) element.focus();
        const selection = element.ownerDocument.defaultView?.getSelection();
        if (selection) {
          const range = element.ownerDocument.createRange();
          range.selectNodeContents(element);
          selection.removeAllRanges();
          selection.addRange(range);
        }
        const doc = element.ownerDocument;
        if (!isCallableValue(doc.execCommand)) return;
        if (next) doc.execCommand("insertText", false, next);
        else doc.execCommand("delete");
      }, value);
    }
    const after = await readTypedFieldText(target);
    if (after != null && !typedFieldMatches(after, value)) {
      throw new Error("human.type could not replace the field contents.");
    }
  }

  function typedFieldMatches(actual, expected) {
    if (expected === "") return String(actual).trim().length === 0;
    return String(actual) === String(expected);
  }

  async function clearTypedField(page, target) {
    await selectAllForClear(page, target);
    await page.keyboard.press("Backspace");
    const afterClear = await readTypedFieldText(target);
    if (afterClear != null && afterClear.trim().length > 0) {
      await restoreTypedFieldText(target, "");
    }
  }

  async function moveTypedFieldCaretToEnd(page, target) {
    if (target && isCallable(untrustedField(target, "evaluate"))) {
      const positioned = await target.evaluate((element) => {
        if (
          element instanceof HTMLInputElement ||
          element instanceof HTMLTextAreaElement
        ) {
          if (
            element instanceof HTMLInputElement &&
            !["text", "search", "url", "tel", "password"].includes(element.type)
          ) return false;
          const end = element.value.length;
          element.setSelectionRange(end, end);
          return true;
        }
        if (!element.isContentEditable) return false;
        const selection = element.ownerDocument.defaultView?.getSelection();
        if (!selection) return false;
        const range = element.ownerDocument.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
        return true;
      });
      if (positioned) return;
    }
    await page.keyboard.press("End");
  }

  async function insertTypedText(page, target, text, before) {
    const value = String(text);
    if (!value) return;
    if (target && isCallable(untrustedField(target, "focus"))) {
      await target.focus().catch(() => {});
    }
    await moveTypedFieldCaretToEnd(page, target);
    await page.keyboard.insertText(value);
    const afterInsert = await readTypedFieldText(target);
    if (afterInsert != null && typedTextLanded(value, before, afterInsert)) return;
    if (!target || !isCallable(untrustedField(target, "evaluate"))) return;
    await target.evaluate((element, inserted) => {
      const isCallableValue = (value: UntrustedValue): value is UntrustedFunction =>
        typeof value === "function";
      if (isCallableValue(element.focus)) element.focus();
      const doc = element.ownerDocument;
      if (
        isCallableValue(doc.execCommand) &&
        doc.execCommand("insertText", false, inserted)
      ) {
        return;
      }
      const eventInit = {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: inserted,
      };
      element.dispatchEvent(new InputEvent("beforeinput", eventInit));
      element.dispatchEvent(new InputEvent("input", eventInit));
    }, value);
  }

  return {
    humanClickTarget,
    clearTypedField,
    moveTypedFieldCaretToEnd,
    readTypedFieldText,
    restoreTypedFieldText,
    insertTypedText,
  };
}
