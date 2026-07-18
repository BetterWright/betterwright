// Small stdin helper for the interactive agent console (bin/betterwright.mjs).
//
// One readline interface is shared by two readers: the console's top-level task
// prompt and the agent's `ask` tool. Both pull the *next* line from the same
// stream, so they must not each attach their own `line` listener and race. This
// serializes reads through a single queue: callers await `nextLine()`, lines are
// handed out in arrival order, and any line typed while no one is waiting is
// buffered for the next caller.

/**
 * Wrap a readline interface in a serial line reader.
 * @param {import("node:readline").Interface} rl
 * @returns {(promptStr?: string) => Promise<string|null>} resolves with the next
 *   line, or `null` once the interface has closed (Ctrl-D / end of input). When a
 *   prompt string is given and no line is already buffered, readline renders it so
 *   line editing stays correct.
 */
export function makeLineReader(rl) {
  const waiters = [];
  const buffered = [];
  let closed = false;

  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else buffered.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });

  return (promptStr = "") => {
    if (buffered.length) return Promise.resolve(buffered.shift());
    if (closed) return Promise.resolve(null);
    if (promptStr) {
      rl.setPrompt(promptStr);
      rl.prompt();
    }
    return new Promise((resolve) => waiters.push(resolve));
  };
}
