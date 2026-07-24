// A frame whose execution context is wedged — still loading, mid-navigation, or
// a third-party widget with a blocked main thread — never settles an evaluate.
// Playwright puts no timeout on `evaluate`/`frameElement`, so probing such a
// frame unbounded stalls the whole credential fill until the snippet deadline
// fires, which restarts the worker and drops the page. One dead iframe must not
// cost the form beside it: every probe gets a deadline, the scan as a whole gets
// a budget, and a frame that misses either is reported rather than waited on.
export const CREDENTIAL_FRAME_PROBE_MS = 5_000;
export const CREDENTIAL_SCAN_BUDGET_MS = 15_000;

const PROBE_TIMED_OUT = Symbol("credential-probe-timed-out");

export function credentialProbeTimedOut(value) {
  return value === PROBE_TIMED_OUT;
}

/** Await `work`, giving up after `ms` and resolving to the timed-out sentinel.
 * A probe that loses the race is abandoned, not cancelled — Playwright offers no
 * way to cancel it — so a value that arrives late is handed to `disposeLate` and
 * a late failure is swallowed, because by then nobody is waiting for it. */
export function withProbeDeadline(work, ms, disposeLate) {
  let expired = false;
  const probe = Promise.resolve(work).then(
    (value) => {
      if (!expired) return value;
      void disposeLate?.(value);
      return PROBE_TIMED_OUT;
    },
    (error) => {
      if (expired) return PROBE_TIMED_OUT;
      throw error;
    },
  );
  let timer;
  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve(PROBE_TIMED_OUT);
    }, Math.max(1, Number(ms) || 1));
  });
  return Promise.race([probe, expiry]).finally(() => clearTimeout(timer));
}

/** Validate already-resolved explicit credential targets without letting any
 * renderer round-trip outlive the scan budget. Callbacks are thunks so a spent
 * budget never starts more Playwright work. */
export async function probePinnedCredentialOrigin({
  inspectDocument,
  originForFrame,
  probeMs = CREDENTIAL_FRAME_PROBE_MS,
  budgetMs = CREDENTIAL_SCAN_BUDGET_MS,
}) {
  const deadline = Date.now() + Math.max(1, Number(budgetMs) || 1);
  const probe = async (phase, work) => {
    const allowance = Math.min(probeMs, deadline - Date.now());
    if (allowance <= 0) return { timedOut: true, phase };
    const value = await withProbeDeadline(work(), allowance);
    return credentialProbeTimedOut(value)
      ? { timedOut: true, phase }
      : { timedOut: false, value };
  };

  const before = await probe("initial document validation", inspectDocument);
  if (before.timedOut) return before;
  const origin = await probe("origin validation", originForFrame);
  if (origin.timedOut) return origin;
  const after = await probe("final document validation", inspectDocument);
  if (after.timedOut) return after;
  return {
    timedOut: false,
    documentUrlBefore: before.value,
    origin: origin.value,
    documentUrlAfter: after.value,
  };
}

function frameLabel(frame) {
  try {
    return String(frame.url() || "") || "about:blank";
  } catch {
    return "about:blank";
  }
}

export async function disposeCredentialFrameDetections(detections) {
  await Promise.allSettled(
    detections.map(async (detection) => detection.dispose()),
  );
}

export async function collectCredentialFrameDetections({
  frames,
  requestedAction,
  originForFrame,
  detectInFrame,
  probeMs = CREDENTIAL_FRAME_PROBE_MS,
  budgetMs = CREDENTIAL_SCAN_BUDGET_MS,
}) {
  const detections = [];
  const unresponsive = [];
  const deadline = Date.now() + Math.max(1, Number(budgetMs) || 1);
  const allowance = () => Math.min(probeMs, deadline - Date.now());
  try {
    for (const frame of frames) {
      if (allowance() <= 0) {
        // The budget is gone. Record the rest without probing: one wedged frame
        // must not turn every frame behind it into another full probe wait.
        unresponsive.push(frameLabel(frame));
        continue;
      }
      try {
        const origin = await withProbeDeadline(originForFrame(frame), allowance());
        if (credentialProbeTimedOut(origin)) {
          unresponsive.push(frameLabel(frame));
          continue;
        }
        if (!origin) continue;
        const detection = await withProbeDeadline(
          detectInFrame(frame, requestedAction),
          allowance(),
          (late) => late?.dispose?.().catch?.(() => {}),
        );
        if (credentialProbeTimedOut(detection)) {
          unresponsive.push(frameLabel(frame));
          continue;
        }
        detection.origin = origin;
        detections.push(detection);
      } catch (error) {
        if (!frame.isDetached()) throw error;
      }
    }
    return { detections, unresponsive };
  } catch (error) {
    await disposeCredentialFrameDetections(detections);
    throw error;
  }
}
