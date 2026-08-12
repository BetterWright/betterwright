// Parking: quiet a page's own work while nothing is driving it.
//
// WHY. A headed browser stops paying for tabs you are not looking at — a
// background tab's requestAnimationFrame callbacks stop, its animations stop,
// its timers are throttled. Headless Chromium has none of that machinery.
// Every open target reports `document.visibilityState === "visible"` forever
// and its frame loop free-runs at the host's refresh rate, so a page with an
// ordinary spinner or canvas keeps a core busy for as long as the session
// lives. Measured on the pinned fork: one session with five such tabs burned
// ~110% CPU while the worker sat completely idle. Four agents is four of those.
//
// None of the obvious levers move it. Page.setWebLifecycleState("frozen"),
// Browser.setWindowBounds({windowState:"minimized"}),
// Emulation.setVirtualTimePolicy("pause"), setFocusEmulationEnabled(false),
// --disable-gpu, --deterministic-mode, --enable-begin-frame-control and
// --screen-info were each measured at no better than noise, because none of
// them makes a headless target non-visible. Making frames cheaper (dropping the
// 2x device scale factor) does nothing either: the loop is not frame-paced, so
// it simply renders more of them for the same CPU.
//
// Parking uses Chromium's native page lifecycle plus its animation scheduler.
// A frozen target retains JavaScript state, pending timers and rAF registrations;
// returning it to active resumes those queues instead of disabling script in the
// renderer. This matches a background/occluded tab without rewriting page APIs.
//
// WHEN. Only between executions. `parkSession` runs when a session's last
// in-flight execution unwinds and `unparkSession` runs before the next one
// begins, so model code never observes a parked page: the window being
// optimized is exactly the one where the model is thinking and nobody is
// driving the browser. That scoping is what makes this safe to have on by
// default.
//
// Frozen pages intentionally stop timers, rAF and animations while idle. They
// resume through the native lifecycle when the next execution begins. Set
// `parkBackgroundPages: false` (or BETTERWRIGHT_PARK_BACKGROUND_PAGES=0) to opt
// out.

/**
 * Per-page parking state. Weak because it is keyed on Playwright Page objects
 * whose lifetime this module does not own; a closed page's entry goes away with
 * it.
 *
 * This is a `desired`/`applied` pair reconciled through `chain`, not a boolean,
 * because the two callers are asymmetric: parking is fired *without* being
 * awaited as an execution unwinds, while unparking is awaited as the next one
 * begins. Those overlap constantly — a fast agent starts its next step before
 * the previous step's park has finished its round trips. Deciding what to do
 * from the state at call time loses that race (the unpark sees a page that is
 * not parked *yet*, does nothing, and the in-flight park then disables script
 * underneath running model code, which is how the credential suite caught it).
 * Recording the intent and letting the chain converge to it cannot: whoever
 * writes `desired` last wins, whatever order the CDP traffic lands in.
 */
const parkState = new WeakMap();

function stateFor(page) {
  let state = parkState.get(page);
  if (!state) {
    state = {
      desired: "active",
      applied: "active",
      chain: Promise.resolve(),
      cdp: null,
      failed: false,
    };
    parkState.set(page, state);
  }
  return state;
}

/** Whether this page is currently parked. Exported for tests and diagnostics. */
export function isParked(page) {
  return parkState.get(page)?.applied === "parked";
}

/**
 * A page's CDP session, created once and reused.
 *
 * A parked page is parked for as long as the model is thinking, so the session
 * is worth keeping: creating one per park/unpark pair would add two round trips
 * to every agent step, which is the opposite of the point.
 */
async function sessionForPage(page, newCDPSession) {
  const state = stateFor(page);
  if (state.cdp) return state.cdp;
  state.cdp = await newCDPSession(page);
  return state.cdp;
}

/**
 * Run `work` after whatever park/unpark is already queued for this page.
 *
 * Failures are swallowed and latched into `state.failed`: parking is an
 * optimization, and a browser that will not park (an old build without the
 * Animation domain, a target that detached mid-call) must still run. Latching
 * stops a page that cannot park from paying the failed round trips on every
 * subsequent step.
 */
function enqueue(page, work) {
  const state = stateFor(page);
  state.chain = state.chain.then(work, work).catch(() => {
    state.failed = true;
  });
  return state.chain;
}

/**
 * Drive the page to whatever `desired` currently says, once the queue reaches
 * this step. Re-reads `desired` at execution time rather than capturing it, so
 * a park queued and then countermanded before it ran is simply not applied.
 *
 * Order matters within each direction. Parking pauses animation timelines before
 * freezing the native page lifecycle; waking activates the lifecycle before
 * restoring playback so pending timers and rAF registrations can resume.
 */
function reconcile(page, newCDPSession) {
  return enqueue(page, async () => {
    const state = stateFor(page);
    if (state.applied === state.desired || page.isClosed()) return;
    if (state.desired === "parked") {
      const cdp = await sessionForPage(page, newCDPSession);
      // Animation.enable is idempotent and must precede setPlaybackRate; the
      // domain reports nothing we consume, it is enabled only to drive the rate.
      await cdp.send("Animation.enable");
      await cdp.send("Animation.setPlaybackRate", { playbackRate: 0 });
      await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
      // NOT Memory.forciblyPurgeJavaScriptMemory. Reclaiming the parked page's
      // V8 heap looks like free memory and measured as a browser-wide crash on
      // the pinned fork (150.0.7871.129): the call returns success and takes the
      // whole browser process down with it a moment later, taking every other
      // session's tabs with it. Parking is not worth a crash.
      state.applied = "parked";
      return;
    }
    const cdp = state.cdp;
    if (!cdp) {
      state.applied = "active";
      return;
    }
    // Native lifecycle activation must land first: it lets pending timers and
    // rAF registrations resume before animation timelines begin advancing.
    await cdp.send("Page.setWebLifecycleState", { state: "active" });
    await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
    state.applied = "active";
  });
}

/**
 * Freeze a page through Chromium's native lifecycle and animation scheduler.
 *
 * @returns whether *this call* parked the page — false for a page that was
 *   already parked, is closed, belongs to a browser that refused to park, or
 *   was woken again before the park reached the front of the queue.
 */
export async function parkPage(page, { newCDPSession }: any = {}) {
  const state = stateFor(page);
  if (state.applied === "parked" || state.failed || page.isClosed()) return false;
  state.desired = "parked";
  await reconcile(page, newCDPSession);
  return state.applied === "parked";
}

/**
 * Undo {@link parkPage}. Safe to call on a page that was never parked.
 *
 * Unlike {@link parkPage} this does not short-circuit on the current state: a
 * park may be queued but not yet applied, and the whole point of waking is to
 * countermand it. It returns once the page is known to be running again.
 *
 * @returns whether the page had been, or was about to be, parked.
 */
export async function unparkPage(page) {
  const state = parkState.get(page);
  if (!state || page.isClosed()) return false;
  if (state.desired === "active" && state.applied === "active") return false;
  state.desired = "active";
  await reconcile(page, null);
  return true;
}

/**
 * Park every page a session owns.
 *
 * Best-effort and unawaited by design at the call site: this runs as an
 * execution unwinds, and a park that fails or races a page close must never
 * turn into a failed run. Pages already closed are skipped.
 */
export async function parkSession(session, deps: any = {}) {
  const results = [];
  for (const page of session.pages.values()) {
    if (page.isClosed()) continue;
    // A page with credential work in flight keeps running. Parking disables
    // script for the whole renderer, isolated worlds included, and the vault
    // sensor lives in one — see the note on `isBusy` in src/vault-capture.ts.
    if (deps.isBusy?.(page)) continue;
    results.push(parkPage(page, deps).catch(() => false));
  }
  const parked = await Promise.all(results);
  return parked.filter(Boolean).length;
}

/**
 * Wake every page a session owns. Awaited before an execution starts, so model
 * code never runs against a page whose script is still disabled.
 */
export async function unparkSession(session) {
  const results = [];
  for (const page of session.pages.values()) {
    if (page.isClosed()) continue;
    results.push(unparkPage(page).catch(() => false));
  }
  const woken = await Promise.all(results);
  return woken.filter(Boolean).length;
}

/**
 * Resolve the parking setting from the launch config and the environment.
 *
 * Parking is only ever right when nobody can see the browser. In headed mode a
 * human is looking at the window, and while a live view is streaming a human is
 * looking at a copy of it; a frozen page in either case is a bug, not an
 * optimization. The explicit option wins over the environment so a program can
 * turn it off for a run on a host that enables it.
 */
export function parkingEnabled({
  config = {},
  env = process.env,
  headless = true,
  liveView = false,
}: any = {}) {
  if (!headless || liveView) return false;
  if (config.parkBackgroundPages === false) return false;
  if (config.parkBackgroundPages === true) return true;
  const flag = String(env?.BETTERWRIGHT_PARK_BACKGROUND_PAGES ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off" || flag === "no") return false;
  return true;
}
