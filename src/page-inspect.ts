// Page-inspection helpers behind the worker's `overlays`, `controls`, and
// `media` sandbox globals. Each takes a Playwright page and returns plain
// JSON; they are kept out of worker.ts so the worker stays orchestration
// and this stays reviewable (and testable) on its own.

const COOKIE_OVERLAY_TEXT = /\b(cookie|consent|privacy|tracking|personal data)\b/i;
const PROMO_OVERLAY_TEXT =
  /\b(newsletter|subscribe|sign[ -]?up|discount|special offer|notifications?|download (?:our|the) app|join (?:our|the) rewards)\b/i;
const COOKIE_REJECT_NAMES = [
  /^(?:reject|decline)(?: all)?(?: cookies)?$/i,
  /^(?:use |only )?(?:essential|necessary)(?: cookies)?(?: only)?$/i,
  /^(?:continue without|do not) (?:accepting|agreeing|cookies)$/i,
];
const COOKIE_ACCEPT_NAMES = [
  /^(?:accept|allow)(?: all)?(?: cookies)?$/i,
  /^(?:agree|i agree|got it|ok(?:ay)?)$/i,
];
const PROMO_DISMISS_NAMES = [
  /^(?:close|dismiss|no thanks|not now|maybe later|skip|continue without signing up)$/i,
  /^(?:×|✕|✖)$/,
];
const OVERLAY_ROOT_SELECTOR = [
  '[role="dialog"]',
  '[aria-modal="true"]',
  '[id*="cookie" i]',
  '[class*="cookie" i]',
  '[id*="consent" i]',
  '[class*="consent" i]',
  '[class*="newsletter" i]',
  '[class*="modal" i]',
  '[class*="popup" i]',
].join(",");

async function clickFirstVisibleByName(root, patterns) {
  for (const pattern of patterns) {
    for (const role of ["button", "link"]) {
      const candidates = root.getByRole(role, { name: pattern });
      const count = Math.min(await candidates.count().catch(() => 0), 4);
      for (let index = 0; index < count; index += 1) {
        const candidate = candidates.nth(index);
        if (!(await candidate.isVisible().catch(() => false))) continue;
        const label = String(
          (await candidate.getAttribute("aria-label").catch(() => "")) ||
            (await candidate.innerText().catch(() => "")) ||
            role,
        ).trim();
        if (
          await candidate
            .click({ timeout: 2_500 })
            .then(() => true)
            .catch(() => false)
        ) {
          return label;
        }
      }
    }
  }
  return null;
}

export async function dismissObstructiveOverlays(page) {
  const dismissed = [];
  for (const frame of page.frames()) {
    for (let pass = 0; pass < 8; pass += 1) {
      const roots = frame.locator(OVERLAY_ROOT_SELECTOR);
      const count = Math.min(await roots.count().catch(() => 0), 16);
      let removed = false;
      for (let index = 0; index < count; index += 1) {
        const root = roots.nth(index);
        if (!(await root.isVisible().catch(() => false))) continue;
        const text = String(await root.innerText().catch(() => "")).slice(0, 2_000);
        let kind = null;
        let label = null;
        if (COOKIE_OVERLAY_TEXT.test(text)) {
          kind = "cookie";
          label = await clickFirstVisibleByName(root, COOKIE_REJECT_NAMES);
          if (!label) label = await clickFirstVisibleByName(root, COOKIE_ACCEPT_NAMES);
        } else if (PROMO_OVERLAY_TEXT.test(text)) {
          kind = "promotion";
          label = await clickFirstVisibleByName(root, PROMO_DISMISS_NAMES);
        }
        if (!label) continue;
        dismissed.push({ kind, label });
        await root.waitFor({ state: "hidden", timeout: 2_500 }).catch(() => {});
        removed = true;
        break;
      }
      if (!removed) break;
    }
  }
  return { dismissed };
}

export async function inspectControls(page) {
  const frames = [];
  for (const frame of page.frames()) {
    const controls = await frame
      .evaluate(() => {
        const selector = [
          "input",
          "select",
          "textarea",
          '[role="checkbox"]',
          '[role="combobox"]',
          '[role="listbox"]',
          '[role="radio"]',
          '[role="slider"]',
          '[role="spinbutton"]',
          '[role="switch"]',
          '[aria-selected="true"]',
          '[aria-pressed="true"]',
        ].join(",");
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const labelFor = (element) => {
          const label = element.labels?.[0] || element.closest("label");
          let labelText = "";
          if (label) {
            const copy = label.cloneNode(true);
            for (const control of copy.querySelectorAll("input,select,textarea,button")) {
              control.remove();
            }
            labelText = copy.textContent;
          }
          return clean(
            element.getAttribute("aria-label") ||
              labelText ||
              element.getAttribute("placeholder") ||
              element.getAttribute("title") ||
              element.getAttribute("name"),
          ).slice(0, 180);
        };
        return [...document.querySelectorAll(selector)].slice(0, 120).map((element) => {
          const type = clean(
            element.getAttribute("role") ||
              element.getAttribute("type") ||
              element.tagName.toLowerCase(),
          );
          const password = type.toLowerCase() === "password";
          const options =
            element instanceof HTMLSelectElement
              ? [...element.options].slice(0, 60).map((option) => ({
                  text: clean(option.textContent).slice(0, 120),
                  value: option.value,
                  selected: option.selected,
                  disabled: option.disabled,
                }))
              : undefined;
          return {
            type,
            label: labelFor(element),
            value: password ? "[redacted]" : "value" in element ? String(element.value) : null,
            checked: "checked" in element ? Boolean(element.checked) : null,
            selected: element.getAttribute("aria-selected"),
            pressed: element.getAttribute("aria-pressed"),
            ariaChecked: element.getAttribute("aria-checked"),
            min: element.getAttribute("min"),
            max: element.getAttribute("max"),
            step: element.getAttribute("step"),
            disabled:
              Boolean((element as HTMLInputElement).disabled) ||
              element.getAttribute("aria-disabled") === "true",
            visible: Boolean(element.getClientRects().length),
            ...(options ? { options } : {}),
          };
        });
      })
      .catch(() => []);
    if (controls.length) frames.push({ url: frame.url(), controls });
  }
  return { frames };
}

export async function inspectMedia(page) {
  const frames = [];
  for (const frame of page.frames()) {
    const media = await frame
      .evaluate(() => {
        const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
        const headings = [...document.querySelectorAll("h1,h2,h3")]
          .filter((element) => element.getClientRects().length)
          .slice(0, 8)
          .map((element) => clean(element.textContent).slice(0, 180));
        return [...document.querySelectorAll<HTMLMediaElement>("video,audio")]
          .slice(0, 20)
          .map((element) => ({
              kind: element.tagName.toLowerCase(),
              title: clean(
                element.getAttribute("aria-label") ||
                  element.getAttribute("title") ||
                  element
                    .closest("figure,section,article")
                    ?.querySelector("figcaption,h1,h2,h3")?.textContent,
              ).slice(0, 240),
              source: element.currentSrc || element.src || null,
              paused: element.paused,
              ended: element.ended,
              currentTime: Number.isFinite(element.currentTime)
                ? element.currentTime
                : null,
              duration: Number.isFinite(element.duration) ? element.duration : null,
              readyState: element.readyState,
              visible: Boolean(element.getClientRects().length),
              documentTitle: document.title,
              headings,
            }));
      })
      .catch(() => []);
    if (media.length) frames.push({ url: frame.url(), media });
  }
  return { frames };
}
