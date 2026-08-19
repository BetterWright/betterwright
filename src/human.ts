// Human-shaped pointer, keyboard, and wheel primitives for BetterWright.
//
// The interaction design is adapted from CloakHQ/CloakBrowser's MIT-licensed
// humanization layer (https://github.com/CloakHQ/cloakbrowser). CloakBrowser's
// browser binary has separate license terms and is not included here.
//
// MIT License
// Copyright (c) 2026 CloakHQ
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

function between(min, max) {
  return min + Math.random() * (max - min);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function easeInOut(t) {
  return t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
}

function cubicBezier(start, control1, control2, end, t) {
  const u = 1 - t;
  return {
    x:
      u ** 3 * start.x +
      3 * u ** 2 * t * control1.x +
      3 * u * t ** 2 * control2.x +
      t ** 3 * end.x,
    y:
      u ** 3 * start.y +
      3 * u ** 2 * t * control1.y +
      3 * u * t ** 2 * control2.y +
      t ** 3 * end.y,
  };
}

export function pointInside(box, inputLike = false) {
  const xRange: [number, number] = inputLike ? [0.08, 0.35] : [0.36, 0.64];
  return {
    x: Math.round(box.x + box.width * between(...xRange)),
    y: Math.round(box.y + box.height * between(0.36, 0.64)),
  };
}

export async function movePointer(mouse, cursor, target, options: any = {}) {
  if (!cursor.initialized) {
    cursor.x = between(420, 760);
    cursor.y = between(42, 64);
    cursor.initialized = true;
    await mouse.move(cursor.x, cursor.y);
  }

  const start = { x: cursor.x, y: cursor.y };
  const distance = Math.hypot(target.x - start.x, target.y - start.y);
  if (distance < 1) return;

  const steps = Math.max(
    18,
    Math.min(72, Math.round(distance / Math.max(Number(options.stepDivisor) || 9, 3))),
  );
  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const perpendicular = { x: -dy / distance, y: dx / distance };
  const control = (t) => ({
    x: start.x + dx * t + perpendicular.x * between(-0.18, 0.18) * distance,
    y: start.y + dy * t + perpendicular.y * between(-0.18, 0.18) * distance,
  });
  const control1 = control(0.28);
  const control2 = control(0.72);

  for (let index = 1; index <= steps; index += 1) {
    const progress = index / steps;
    const point = cubicBezier(
      start,
      control1,
      control2,
      target,
      easeInOut(progress),
    );
    const wobble = Math.sin(Math.PI * progress) * 0.9;
    await mouse.move(
      Math.round(point.x + between(-wobble, wobble)),
      Math.round(point.y + between(-wobble, wobble)),
    );
    if (index < steps && index % 4 === 0) await sleep(between(7, 16));
  }

  cursor.x = target.x;
  cursor.y = target.y;
}

export async function pressPointer(mouse, inputLike = false) {
  await sleep(inputLike ? between(45, 110) : between(70, 165));
  await mouse.down();
  await sleep(inputLike ? between(35, 85) : between(50, 125));
  await mouse.up();
}

// True only when `text` is present as a *new* change. A field that already
// contained the requested string and did not change is a miss (append into a
// key-swallowing editor). A non-empty change that does not contain `text` is
// also a miss (the editor accepted a prefix). Unreadable targets and empty
// requests cannot be verified and pass.
export function typedTextLanded(expected, before, after) {
  if (!expected || after == null) return true;
  const beforeText = String(before ?? "");
  const afterText = String(after);
  return afterText.includes(String(expected)) && afterText !== beforeText;
}

export async function typeText(keyboard, text, options: any = {}) {
  const minDelay = Math.max(10, Number(options.minDelay) || 35);
  const maxDelay = Math.max(minDelay, Number(options.maxDelay) || 95);
  const characters = [...String(text)];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    if (character.codePointAt(0) > 127) await keyboard.insertText(character);
    else await keyboard.type(character);
    if (index < characters.length - 1) {
      await sleep(
        Math.random() < 0.08 ? between(180, 420) : between(minDelay, maxDelay),
      );
    }
  }
}

export async function scrollWheel(mouse, deltaX, deltaY, options: any = {}) {
  const longest = Math.max(Math.abs(deltaX), Math.abs(deltaY));
  const requestedSteps = Number(options.steps);
  const steps = Math.max(
    2,
    Math.min(40, Number.isFinite(requestedSteps) ? Math.round(requestedSteps) : Math.ceil(longest / 90)),
  );
  for (let index = 1; index <= steps; index += 1) {
    const previous = easeInOut((index - 1) / steps);
    const current = easeInOut(index / steps);
    await mouse.wheel(
      Math.round(deltaX * (current - previous)),
      Math.round(deltaY * (current - previous)),
    );
    if (index < steps) await sleep(between(18, 55));
  }
  await sleep(between(120, 260));
}
