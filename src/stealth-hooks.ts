// Module-resolution hook that redirects every `playwright-core` import to the
// pre-patched `patchright-core` drop-in. Registered off-thread via
// `stealth-register.ts` (see there for why this is a separate file).
//
// The redirect covers BetterWright's own worker import, so the whole process
// drives the managed BetterChromium fork through one driver.
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
