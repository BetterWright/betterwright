import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { piImageContent } from "../../src/pi.mjs";

test("Pi image blocks use top-level data and mimeType", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "betterwright-pi-"));
  const screenshot = path.join(dir, "proof.png");
  await fs.writeFile(screenshot, Buffer.from("fake png"));
  try {
    const content = await piImageContent({
      artifacts: [{ kind: "proof", path: screenshot, media: `MEDIA:${screenshot}` }],
    });
    assert.deepEqual(content, [
      {
        type: "image",
        data: Buffer.from("fake png").toString("base64"),
        mimeType: "image/png",
      },
    ]);
    assert.equal("source" in content[0], false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Pi image blocks attach captcha text crops", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "betterwright-pi-"));
  const screenshot = path.join(dir, "captcha-text.png");
  await fs.writeFile(screenshot, Buffer.from("captcha crop"));
  try {
    const content = await piImageContent({
      artifacts: [{ kind: "captcha", path: screenshot }],
    });
    assert.equal(content.length, 1);
    assert.equal(content[0].mimeType, "image/png");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("Pi image adapter ignores spilled output and oversized images", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "betterwright-pi-"));
  const spill = path.join(dir, "browser-output.json");
  const screenshot = path.join(dir, "proof.png");
  await fs.writeFile(spill, "{}");
  await fs.writeFile(screenshot, "too large");
  try {
    const content = await piImageContent(
      {
        artifacts: [
          { kind: "artifact", path: spill, media: `MEDIA:${spill}` },
          { kind: "proof", path: screenshot, media: `MEDIA:${screenshot}` },
        ],
      },
      { maxImageBytes: 2 },
    );
    assert.deepEqual(content, []);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
