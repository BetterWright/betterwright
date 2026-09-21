import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Page } from "playwright-core";
import {
  createWorkerArtifacts,
  MAX_TRACKED_ARTIFACTS,
  type WorkerArtifactConfig,
} from "../../dist/src/worker-artifacts.js";

function fixture(t, config: Partial<WorkerArtifactConfig> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bw-worker-artifacts-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = {
    id: "quota-session",
    pages: new Map<string, Page>(),
    // SAFETY: these empty arrays establish the element types required by the
    // artifact subsystem before tests add representative entries.
    artifacts: [] as Array<{ kind: string; path: string; mimeType?: string }>,
    // SAFETY: this empty array establishes a mutable string warning sink.
    warnings: [] as string[],
    reservedArtifactBytes: 0,
  };
  // SAFETY: quota tests use the Page value only as an opaque identity key.
  const page = Object.create(null) as Page;
  session.pages.set("page-1", page);
  const settings = {
    artifactsDir: root,
    ...config,
  };
  const artifacts = createWorkerArtifacts({
    getConfig: () => settings,
    newCDPSession: async () => {
      throw new Error("CDP is not used by quota tests.");
    },
    sessions: () => [session],
    ensureSessionPage: async () => page,
    pageId: () => "page-1",
    wakeSessionPages: async () => {},
    quietSessionPages: () => {},
    redactText: String,
    actionTimeoutMs: 5_000,
  });
  return { artifacts, page, root, session };
}

function recordingHandle() {
  const result = {
    state: "completed" as const,
    path: "recording.mp4",
    fps: 60,
    capturedFrames: 1,
    outputFrames: 1,
    droppedFrames: 0,
    durationMs: 1,
    bytes: 1,
  };
  return {
    status: () => result,
    stop: async () => result,
  };
}

test("artifact quota evicts oldest files but never an active recording", t => {
  const { artifacts, page, session } = fixture(t, { maxArtifactBytes: 10 });
  const directory = artifacts.artifactDir(session);
  const active = path.join(directory, "active.mp4");
  const oldest = path.join(directory, "oldest.bin");
  const newest = path.join(directory, "newest.bin");
  fs.writeFileSync(active, Buffer.alloc(6));
  fs.writeFileSync(oldest, Buffer.alloc(3));
  fs.writeFileSync(newest, Buffer.alloc(1));
  fs.utimesSync(oldest, 1, 1);
  fs.utimesSync(newest, 2, 2);
  fs.utimesSync(active, 3, 3);

  session.reservedArtifactBytes = 6;
  const handle = recordingHandle();
  const owner = { handle, page, path: active };
  artifacts.sessionRecordings.set(session.id, {
    state: "active",
    page,
    path: active,
    ready: Promise.resolve(owner),
  });

  artifacts.pruneArtifactQuota(session, 2);

  assert.equal(fs.existsSync(active), true);
  assert.equal(fs.existsSync(oldest), false);
  assert.equal(fs.existsSync(newest), true);
  assert.deepEqual(session.warnings, ["Artifact quota removed oldest.bin."]);
});

test("artifact reservations release exactly once", t => {
  const { artifacts, session } = fixture(t, { maxArtifactBytes: 20 });
  const release = artifacts.reserveArtifactQuota(session, 7);
  assert.equal(session.reservedArtifactBytes, 7);
  release();
  release();
  assert.equal(session.reservedArtifactBytes, 0);
});

test("an active recording consumes the final tracked-artifact slot", t => {
  const { artifacts, page, session } = fixture(t);
  session.artifacts = Array.from(
    { length: MAX_TRACKED_ARTIFACTS - 1 },
    (_, index) => ({ kind: "artifact", path: `artifact-${index}` }),
  );
  const handle = recordingHandle();
  const owner = { handle, page, path: "active.mp4" };
  artifacts.sessionRecordings.set(session.id, {
    state: "active",
    page,
    path: owner.path,
    ready: Promise.resolve(owner),
  });

  assert.throws(
    () => artifacts.makeArtifactPath(session, "extra.txt"),
    /Browser artifact limit \(500\) reached/,
  );
});
