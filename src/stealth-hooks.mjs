// Module-resolution hook that redirects every `playwright-core` import to the
// pre-patched `patchright-core` drop-in. Registered off-thread via
// `stealth-register.mjs` (see there for why this is a separate file).
//
// This is what makes the optional Runtime.enable stealth fix reach the managed
// Cloak path: `cloakbrowser` resolves its driver with a bare
// `import("playwright-core")` and exposes no injection hook, so the only way to
// swap the driver it uses is to intercept that specifier before Node resolves
// it. The same redirect also covers BetterWright's own worker import and the
// stock-Chromium fallback, so the whole process uses one driver.
//
// patchright-core is an exact-version drop-in for playwright-core@1.61.x, so the
// redirect is API-compatible; it just changes the CDP behaviour (no blanket
// `Runtime.enable`, Console API left disabled) that anti-bot vendors detect.

const PLAYWRIGHT_CORE = "playwright-core";
const PATCHRIGHT_CORE = "patchright-core";

export async function resolve(specifier, context, next) {
  if (specifier === PLAYWRIGHT_CORE || specifier.startsWith(`${PLAYWRIGHT_CORE}/`)) {
    const redirected = PATCHRIGHT_CORE + specifier.slice(PLAYWRIGHT_CORE.length);
    return next(redirected, context);
  }
  return next(specifier, context);
}
