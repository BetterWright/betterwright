// Contract tests for the humanized input primitives in src/human.ts. The
// functions take the Playwright mouse/keyboard as parameters, so plain
// recording fakes are enough — no browser, no mocking framework. Where a test
// needs deterministic geometry or timing, Math.random and setTimeout are
// pinned through t.mock; the distribution-style pointInside tests run the
// real generator many times instead, because the spread IS the contract.

import assert from "node:assert/strict";
import test from "node:test";

import {
  movePointer,
  pointInside,
  pressPointer,
  scrollWheel,
  typedTextLanded,
  typeText,
} from "../../dist/src/human.js";

// The pointer state movePointer initializes and then tracks between moves.
interface CursorState {
  x?: number;
  y?: number;
  initialized?: boolean;
}

function fakeMouse() {
  const calls = [];
  return {
    calls,
    async move(x, y) {
      calls.push(["move", x, y]);
    },
    async down() {
      calls.push(["down"]);
    },
    async up() {
      calls.push(["up"]);
    },
    async wheel(deltaX, deltaY) {
      calls.push(["wheel", deltaX, deltaY]);
    },
  };
}

function fakeKeyboard() {
  const calls = [];
  return {
    calls,
    async type(text) {
      calls.push(["type", text]);
    },
    async insertText(text) {
      calls.push(["insertText", text]);
    },
  };
}

// Lets promise continuations (the awaits between fake-clock sleeps) run.
// setImmediate stays real because only the setTimeout api is mocked.
function drain() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Advances the mocked clock until the work under test settles. Each tick is
// generous (1s) because these tests assert call sequences, not exact delays;
// the delay-precision tests tick manually instead.
async function tickUntilSettled(t, promise) {
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  while (!settled) {
    t.mock.timers.tick(1_000);
    await drain();
  }
  return promise;
}

test("pointInside stays inside the box, away from the edges", () => {
  const box = { x: 100, y: 50, width: 200, height: 80 };
  for (let i = 0; i < 300; i += 1) {
    const point = pointInside(box);
    assert.ok(Number.isInteger(point.x) && Number.isInteger(point.y));
    // Clicks near a border risk hitting the neighbor element; the point must
    // land in the middle band, never on the edge.
    assert.ok(point.x > box.x + box.width * 0.05, `x=${point.x} too far left`);
    assert.ok(point.x < box.x + box.width * 0.95, `x=${point.x} too far right`);
    assert.ok(point.y > box.y + box.height * 0.3, `y=${point.y} too high`);
    assert.ok(point.y < box.y + box.height * 0.7, `y=${point.y} too low`);
  }
});

test("pointInside biases input-like targets toward the left text area", () => {
  const box = { x: 100, y: 50, width: 200, height: 80 };
  for (let i = 0; i < 300; i += 1) {
    const point = pointInside(box, true);
    assert.ok(Number.isInteger(point.x) && Number.isInteger(point.y));
    assert.ok(point.x > box.x, `x=${point.x} escaped the box`);
    // Humans click where the text starts, not the field's center.
    assert.ok(
      point.x < box.x + box.width / 2,
      `x=${point.x} must stay left of center for an input`,
    );
    assert.ok(point.y > box.y + box.height * 0.3, `y=${point.y} too high`);
    assert.ok(point.y < box.y + box.height * 0.7, `y=${point.y} too low`);
  }
});

test("movePointer initializes a fresh cursor in the chrome area and lands exactly on target", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.5);
  const mouse = fakeMouse();
  const cursor: CursorState = {};
  const target = { x: 400, y: 300 };
  await tickUntilSettled(t, movePointer(mouse, cursor, target));

  // An uninitialized cursor first teleports to a plausible resting spot near
  // the browser chrome (tab strip / URL bar), then walks from there.
  const [, startX, startY] = mouse.calls[0];
  assert.equal(mouse.calls[0][0], "move");
  assert.ok(startX >= 420 && startX <= 760, `start x=${startX}`);
  assert.ok(startY >= 42 && startY <= 64, `start y=${startY}`);
  assert.equal(cursor.initialized, true);

  // The walk ends exactly on the target — an off-by-a-pixel landing would
  // miss small elements — and the cursor state tracks it for the next move.
  assert.deepEqual(mouse.calls.at(-1), ["move", 400, 300]);
  assert.equal(cursor.x, 400);
  assert.equal(cursor.y, 300);

  // Every emitted coordinate is an integer (CDP dispatches whole pixels) and
  // the path length stays within the documented 18..72 step envelope.
  for (const [, x, y] of mouse.calls) {
    assert.ok(Number.isInteger(x) && Number.isInteger(y));
  }
  const steps = mouse.calls.length - 1; // minus the initialization teleport
  assert.ok(steps >= 18 && steps <= 72, `steps=${steps}`);

  // Already on target: a sub-pixel distance must not emit any movement.
  const before = mouse.calls.length;
  await tickUntilSettled(t, movePointer(mouse, cursor, { x: 400.4, y: 300.2 }));
  assert.equal(mouse.calls.length, before);
});

test("movePointer walks short hops in 18 steps along the straight line", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // Pinning random to 0.5 zeroes the curve and wobble offsets, so the path
  // must be the plain segment: y constant, x monotone toward the target.
  t.mock.method(Math, "random", () => 0.5);
  const mouse = fakeMouse();
  const cursor = { x: 100, y: 100, initialized: true };
  await tickUntilSettled(t, movePointer(mouse, cursor, { x: 110, y: 100 }));
  assert.equal(mouse.calls.length, 18, "short hops still take the 18-step minimum");
  let lastX = 100;
  for (const [, x, y] of mouse.calls) {
    assert.equal(y, 100);
    assert.ok(x >= lastX && x <= 110, `x=${x} left the segment`);
    lastX = x;
  }
  assert.equal(lastX, 110);
});

test("movePointer caps long hauls at 72 steps and honors stepDivisor", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.5);
  const capped = fakeMouse();
  await tickUntilSettled(
    t,
    movePointer(capped, { x: 0, y: 0, initialized: true }, { x: 5000, y: 0 }),
  );
  assert.equal(capped.calls.length, 72);

  // A larger divisor coarsens the walk (fewer steps) without changing where
  // it ends.
  const coarse = fakeMouse();
  await tickUntilSettled(
    t,
    movePointer(coarse, { x: 0, y: 0, initialized: true }, { x: 5000, y: 0 }, { stepDivisor: 100 }),
  );
  assert.equal(coarse.calls.length, 50);
  assert.deepEqual(coarse.calls.at(-1), ["move", 5000, 0]);
});

test("pressPointer dwells before pressing and between down and up", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // random → 0 pins the dwells at their minimums (70ms pre-press, 50ms held).
  t.mock.method(Math, "random", () => 0);
  const mouse = fakeMouse();
  const done = pressPointer(mouse);
  let settled = false;
  done.then(() => {
    settled = true;
  });

  await drain();
  assert.deepEqual(mouse.calls, [], "the press must not start instantly");
  t.mock.timers.tick(69);
  await drain();
  assert.deepEqual(mouse.calls, [], "a sub-70ms pre-press dwell is too robotic");
  t.mock.timers.tick(1);
  await drain();
  assert.deepEqual(mouse.calls, [["down"]]);

  t.mock.timers.tick(49);
  await drain();
  assert.deepEqual(mouse.calls, [["down"]], "the button must stay held for 50ms");
  t.mock.timers.tick(1);
  await drain();
  assert.deepEqual(mouse.calls, [["down"], ["up"]]);
  assert.equal(settled, true);
  await done;
});

test("typedTextLanded requires the requested text as a full insert", () => {
  assert.equal(typedTextLanded("", "", ""), true);
  assert.equal(typedTextLanded("hello", "", null), true);
  assert.equal(typedTextLanded("hello", "", "hello"), true);
  assert.equal(typedTextLanded("hello", "pre", "prehello"), true);
  assert.equal(typedTextLanded("hello", "hello", "hellohello"), true);
  assert.equal(typedTextLanded("Lovelace", "\n", "Lovelace"), true);
  // Partial accept: the field changed but is not a full insert of the request.
  assert.equal(typedTextLanded("hello", "", "hel"), false);
  // Unchanged append: the request is already in the field and nothing new landed.
  assert.equal(typedTextLanded("hello", "hello", "hello"), false);
  assert.equal(typedTextLanded("Ada", "Ada Lovelace", "Ada Lovelace"), false);
  // Partial append: leftover occurrence plus a fragment, or an overlapping prefix.
  assert.equal(typedTextLanded("hello", "hello", "helloX"), false);
  assert.equal(typedTextLanded("Ada", "Ada Lovelace", "Ada Lovelace!"), false);
  assert.equal(typedTextLanded("aaa", "aa", "aaaa"), false);
  assert.equal(typedTextLanded("aaa", "aa", "aaaaa"), true);
});

test("typeText routes ASCII through type and everything else through insertText, per character", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.5);
  const keyboard = fakeKeyboard();
  // The emoji is an astral pair: it must arrive as one insertText, not two
  // broken surrogates.
  await tickUntilSettled(t, typeText(keyboard, "ab~é漢😀"));
  assert.deepEqual(keyboard.calls, [
    ["type", "a"],
    ["type", "b"],
    ["type", "~"],
    ["insertText", "é"],
    ["insertText", "漢"],
    ["insertText", "😀"],
  ]);

  // Non-string input is coerced, not crashed on.
  const numeric = fakeKeyboard();
  await tickUntilSettled(t, typeText(numeric, 42));
  assert.deepEqual(numeric.calls, [
    ["type", "4"],
    ["type", "2"],
  ]);

  // Empty text is a no-op.
  const empty = fakeKeyboard();
  await tickUntilSettled(t, typeText(empty, ""));
  assert.deepEqual(empty.calls, []);
});

test("typeText floors configured delays at 10ms and never sleeps after the last character", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0.5);
  const keyboard = fakeKeyboard();
  const done = typeText(keyboard, "ab", { minDelay: 1, maxDelay: 1 });
  let settled = false;
  done.then(() => {
    settled = true;
  });

  await drain();
  assert.deepEqual(keyboard.calls, [["type", "a"]]);
  // A 1ms request is clamped up to the 10ms floor — anything faster than
  // 10ms/key is machine-speed typing.
  t.mock.timers.tick(9);
  await drain();
  assert.equal(keyboard.calls.length, 1, "9ms must not satisfy the 10ms floor");
  t.mock.timers.tick(1);
  await drain();
  assert.deepEqual(keyboard.calls.at(-1), ["type", "b"]);
  // The last character ends the call: no trailing sleep to tick through.
  assert.equal(settled, true);
  await done;
});

test("typeText occasionally pauses like a human thinking (the 180ms+ burst gap)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // random → 0 forces every gap onto the rare long-pause branch at its 180ms
  // minimum, making the branch deterministic instead of 8%-flaky.
  t.mock.method(Math, "random", () => 0);
  const keyboard = fakeKeyboard();
  const done = typeText(keyboard, "ab");
  await drain();
  assert.deepEqual(keyboard.calls, [["type", "a"]]);
  t.mock.timers.tick(179);
  await drain();
  assert.equal(keyboard.calls.length, 1, "the thinking pause lasts at least 180ms");
  t.mock.timers.tick(1);
  await drain();
  assert.deepEqual(keyboard.calls.at(-1), ["type", "b"]);
  await done;
});

test("scrollWheel splits the delta across steps and pauses to let the page settle", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0);
  const mouse = fakeMouse();
  const done = scrollWheel(mouse, 0, 100, { steps: 2 });
  let settled = false;
  done.then(() => {
    settled = true;
  });

  await drain();
  assert.deepEqual(mouse.calls, [["wheel", 0, 50]]);
  t.mock.timers.tick(18); // the minimum inter-step pause
  await drain();
  assert.deepEqual(mouse.calls, [
    ["wheel", 0, 50],
    ["wheel", 0, 50],
  ]);
  // The delta is fully delivered, but the call is not done: a trailing settle
  // pause (120ms minimum) lets lazy-loaded content arrive before the caller
  // observes the page.
  assert.equal(settled, false);
  t.mock.timers.tick(119);
  await drain();
  assert.equal(settled, false);
  t.mock.timers.tick(1);
  await drain();
  assert.equal(settled, true);
  await done;
});

test("scrollWheel derives ~90px steps by the longest axis and lands on the requested total", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0);
  // |dx|=450 dominates |dy|=90, so ceil(450/90) = 5 steps for both axes.
  const mouse = fakeMouse();
  await tickUntilSettled(t, scrollWheel(mouse, -450, 90));
  assert.equal(mouse.calls.length, 5);
  const totalX = mouse.calls.reduce((sum, [, dx]) => sum + dx, 0);
  const totalY = mouse.calls.reduce((sum, [, , dy]) => sum + dy, 0);
  // Per-step rounding may shave fractions, but the delivered scroll must sum
  // to the request within half a pixel per step — never drift beyond that.
  assert.ok(Math.abs(totalX - -450) <= mouse.calls.length / 2, `totalX=${totalX}`);
  assert.ok(Math.abs(totalY - 90) <= mouse.calls.length / 2, `totalY=${totalY}`);
});

test("scrollWheel clamps requested step counts into the 2..40 envelope", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(Math, "random", () => 0);
  const floor = fakeMouse();
  await tickUntilSettled(t, scrollWheel(floor, 0, 100, { steps: -5 }));
  assert.equal(floor.calls.length, 2, "a single-burst scroll is too robotic");

  const ceiling = fakeMouse();
  await tickUntilSettled(t, scrollWheel(ceiling, 0, 100, { steps: 999 }));
  assert.equal(ceiling.calls.length, 40, "unbounded steps would take forever");
  const total = ceiling.calls.reduce((sum, [, , dy]) => sum + dy, 0);
  assert.ok(Math.abs(total - 100) <= ceiling.calls.length / 2, `total=${total}`);
});
