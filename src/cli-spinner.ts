// A working indicator for the CLI's two live surfaces: the interactive
// console (which animates its readline prompt) and exec's stderr stream.
//
// The agent can sit inside one model call for ten seconds or more with
// nothing to print. Without a pulse on screen that silence reads as a hang.
// The console builds its own prompt string from these frames because readline
// owns the input line there; exec gets the self-contained stream spinner.
//
// Same contract as the theme: animation only on a TTY. Piped and redirected
// output keeps exactly the plain lines it always had.

import type { CliPaint } from "./cli-theme.js";

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const SPINNER_INTERVAL_MS = 120;

// What each agent phase should read as while the user waits on it. The
// acting label comes from the first tool in the batch; a batch rarely mixes
// tools, and the step line that follows names each one anyway.
const ACTING_LABELS = {
  browser: "browsing",
  login: "logging in",
  ask: "waiting for your answer",
  handoff: "waiting for your hands",
  live_view: "opening live view",
  done: "finishing",
};

/** The wait label for a runAgentTask onPhase event: "reasoning", "browsing", … */
export function phaseLabel(event: { phase?: string; tools?: string[] } = {}): string {
  if (event.phase !== "acting") return "reasoning";
  return ACTING_LABELS[event.tools?.[0] ?? ""] || "working";
}

/** Whole-second elapsed time for a live counter: "7s", then "1m 07s". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * A spinner that owns the current line of `stream`: "  ⠹ working · 12s".
 * `clear()` erases it so a real line can be written in its place; the next
 * tick redraws it below. Every method is a no-op when the stream is not a
 * TTY, so callers never have to guard.
 */
export function createSpinner({
  stream,
  paint,
  label = "working",
}: {
  stream: NodeJS.WriteStream;
  paint: CliPaint;
  label?: string;
}) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let startedAt = 0;
  let tick = 0;
  let visible = false;
  let current = label;

  const render = () => {
    const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
    tick += 1;
    const elapsed = formatElapsed(Date.now() - startedAt);
    stream.write(`\r\x1b[2K  ${paint.accent(frame)} ${paint.dim(`${current} · ${elapsed}`)}`);
    visible = true;
  };
  const clear = () => {
    if (!visible) return;
    stream.write("\r\x1b[2K");
    visible = false;
  };

  return {
    start() {
      if (!stream.isTTY || timer) return;
      startedAt = Date.now();
      tick = 0;
      render();
      timer = setInterval(render, SPINNER_INTERVAL_MS);
      // The spinner must never keep the process alive on its own.
      timer.unref?.();
    },
    /** Erase the spinner line so the caller can print a real line. */
    clear,
    /**
     * Change what the wait is called ("reasoning" → "browsing"). The counter
     * restarts so it reads as time spent in this phase, not the whole run.
     */
    setLabel(text: string) {
      if (text === current) return;
      current = text;
      startedAt = Date.now();
      if (timer) render();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      clear();
    },
  };
}
