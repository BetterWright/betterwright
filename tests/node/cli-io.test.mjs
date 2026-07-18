import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { makeLineReader } from "../../src/cli-io.mjs";

// A minimal readline stand-in: emits "line"/"close" and records prompts.
function fakeReadline() {
  const rl = new EventEmitter();
  rl.prompts = [];
  rl.setPrompt = (p) => rl.prompts.push(p);
  rl.prompt = () => {};
  return rl;
}

test("makeLineReader hands out lines in arrival order to awaiting callers", async () => {
  const rl = fakeReadline();
  const nextLine = makeLineReader(rl);
  const first = nextLine();
  const second = nextLine();
  rl.emit("line", "alpha");
  rl.emit("line", "beta");
  assert.equal(await first, "alpha");
  assert.equal(await second, "beta");
});

test("makeLineReader buffers a line typed while no one is waiting", async () => {
  const rl = fakeReadline();
  const nextLine = makeLineReader(rl);
  rl.emit("line", "early"); // arrives before any awaiter
  assert.equal(await nextLine(), "early");
});

test("makeLineReader resolves null at close, for pending and future reads", async () => {
  const rl = fakeReadline();
  const nextLine = makeLineReader(rl);
  const pending = nextLine();
  rl.emit("close");
  assert.equal(await pending, null); // pending waiter drained
  assert.equal(await nextLine(), null); // and every read after close
});

test("makeLineReader renders a prompt only when it must wait", async () => {
  const rl = fakeReadline();
  const nextLine = makeLineReader(rl);
  rl.emit("line", "buffered");
  // A buffered line is returned without rendering a prompt.
  await nextLine("should-not-render ▸ ");
  assert.deepEqual(rl.prompts, []);
  // With nothing buffered, the prompt is set and rendered.
  const waiting = nextLine("ask ▸ ");
  assert.deepEqual(rl.prompts, ["ask ▸ "]);
  rl.emit("line", "answer");
  assert.equal(await waiting, "answer");
});
