// Read-only maintainer check. Fetches metadata and small configuration files,
// never model weights. Run after `bun run build:harness`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { LOCAL_DFLASH2, LOCAL_MODELS, type LocalArtifact } from "../dist/src/local-ai-catalog.js";
import { isString, untrustedField } from "../dist/src/untrusted-value.js";

const groups = new Map<string, { repository: string; revision: string; files: Map<string, LocalArtifact> }>();
for (const model of [...LOCAL_MODELS, LOCAL_DFLASH2]) {
  const key = `${model.repository}@${model.revision}`;
  let group = groups.get(key);
  if (!group) { group = { repository: model.repository, revision: model.revision, files: new Map() }; groups.set(key, group); }
  for (const artifact of model.files) group.files.set(`${artifact.subdirectory ? `${artifact.subdirectory}/` : ""}${artifact.name}`, artifact);
}
let count = 0;
for (const [key, group] of groups) {
  const response = await fetch(`https://huggingface.co/api/models/${group.repository}/revision/${group.revision}?blobs=true`, { signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, `Cannot read metadata for ${key}: ${response.status}`);
  const metadata = await response.json();
  assert.equal(untrustedField(metadata, "sha"), group.revision);
  const siblings = untrustedField(metadata, "siblings");
  assert.ok(Array.isArray(siblings), `No file metadata for ${key}`);
  for (const artifact of group.files.values()) {
    const remoteName = `${artifact.subdirectory ? `${artifact.subdirectory}/` : ""}${artifact.name}`;
    const sibling = siblings.find(file => untrustedField(file, "rfilename") === remoteName);
    assert.ok(sibling, `Missing ${key}/${artifact.name}`);
    assert.equal(untrustedField(sibling, "size"), artifact.bytes, `${artifact.name}: size drift`);
    assert.equal(artifact.url, `https://huggingface.co/${group.repository}/resolve/${group.revision}/${remoteName}`);
    const hash = untrustedField(untrustedField(sibling, "lfs"), "sha256");
    if (isString(hash)) assert.equal(hash, artifact.sha256, `${artifact.name}: LFS hash drift`);
    else {
      assert.ok(artifact.bytes <= 32 * 1024 * 1024, "Refusing a large non-LFS download");
      const file = await fetch(artifact.url, { signal: AbortSignal.timeout(30_000) });
      assert.ok(file.ok && file.body, `Cannot read ${artifact.name}`);
      const digest = createHash("sha256");
      let bytes = 0;
      const reader = file.body.getReader();
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          assert.ok(bytes <= artifact.bytes, `${artifact.name}: exceeds pinned size`);
          digest.update(chunk.value);
        }
      } finally { await reader.cancel(); }
      assert.equal(bytes, artifact.bytes); assert.equal(digest.digest("hex"), artifact.sha256);
    }
    count++;
  }
  console.log(`${key}: ${group.files.size} artifacts verified`);
}
console.log(`Verified ${count} distinct pinned artifacts without downloading model weights.`);
