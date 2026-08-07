import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import {
  defaultObscuraRoot,
  OBSCURA_ASSETS,
  OBSCURA_PLATFORM_LAYOUT,
  OBSCURA_RELEASE_TAG,
  OBSCURA_REPOSITORY,
  OBSCURA_VERSION,
  OBSCURA_VERSION_MARKER,
  obscuraPlatformKey,
  resolveObscuraBinary,
} from "./obscura.js";

export function obscuraAssetForHost({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  return OBSCURA_ASSETS[obscuraPlatformKey(platform, arch)] || null;
}

function releaseDownloadUrl(repo, tag, name) {
  return `https://github.com/${repo}/releases/download/${tag}/${name}`;
}

function sha256File(filePath) {
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function downloadToFile(url, destPath, { redirectsLeft = 5 }: any = {}) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        headers: {
          "User-Agent": "betterwright-obscura-install",
          Accept: "application/octet-stream",
        },
      },
      (response) => {
        const status = response.statusCode || 0;
        if (
          status >= 300 &&
          status < 400 &&
          response.headers.location &&
          redirectsLeft > 0
        ) {
          response.resume();
          downloadToFile(response.headers.location, destPath, {
            redirectsLeft: redirectsLeft - 1,
          }).then(resolve, reject);
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`Download failed (${status}) for ${url}.`));
          return;
        }
        const out = fs.createWriteStream(destPath);
        pipeline(response, out).then(resolve, reject);
      },
    );
    request.on("error", reject);
  });
}

function extractArchive(
  archivePath,
  destDir,
  { platform = process.platform, spawn = spawnSync } = {},
) {
  fs.mkdirSync(destDir, { recursive: true, mode: 0o755 });
  const command = platform === "win32" ? "tar.exe" : "tar";
  const args = platform === "win32"
    ? ["-xf", archivePath, "-C", destDir]
    : ["-xzf", archivePath, "-C", destDir];
  const result = spawn(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} extract failed: ${result.stderr || result.stdout || "unknown error"}`,
    );
  }
}

export const _extractObscuraArchiveForTest = extractArchive;

export async function installObscura({
  home = os.homedir(),
  platform = process.platform,
  arch = process.arch,
  repo = process.env.BETTERWRIGHT_OBSCURA_REPO || OBSCURA_REPOSITORY,
  releaseTag = process.env.BETTERWRIGHT_OBSCURA_RELEASE_TAG ||
    OBSCURA_RELEASE_TAG,
  force = false,
  log = console.log,
  download = downloadToFile,
  extract = extractArchive,
  existsSync = fs.existsSync,
  assets = OBSCURA_ASSETS,
} = {}) {
  const key = obscuraPlatformKey(platform, arch);
  const asset = assets[key];
  const root = defaultObscuraRoot({ home });
  if (!asset) {
    return {
      binary: null,
      root,
      skipped: `No managed Obscura artifact for ${key}; using the Chromium compatibility backend.`,
    };
  }

  const layout = OBSCURA_PLATFORM_LAYOUT[key];
  const binaryPath = path.join(root, layout);
  if (!force && existsSync(binaryPath)) {
    const resolved = resolveObscuraBinary({
      env: {},
      platform,
      arch,
      home,
      existsSync,
    });
    if (resolved) {
      log(`Obscura already installed: ${resolved}`);
      log(`Re-run with --force to re-download ${OBSCURA_VERSION}.`);
      return { binary: resolved, root, skipped: null, alreadyInstalled: true };
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-obscura-"));
  const archivePath = path.join(tmpDir, asset.name);
  const url = releaseDownloadUrl(repo, releaseTag, asset.name);
  const platformDir = path.dirname(binaryPath);
  const stagedDir = `${platformDir}.staged-${process.pid}-${Date.now()}`;
  const backupDir = `${platformDir}.previous-${process.pid}-${Date.now()}`;
  try {
    log(`Downloading Obscura ${OBSCURA_VERSION}...`);
    log(`  ${url}`);
    await download(url, archivePath);
    const actual = sha256File(archivePath);
    if (actual !== asset.sha256) {
      throw new Error(
        `SHA-256 mismatch for ${asset.name}: expected ${asset.sha256}, got ${actual}`,
      );
    }
    log(`Checksum OK (${actual.slice(0, 12)}…)`);

    fs.rmSync(stagedDir, { recursive: true, force: true });
    fs.mkdirSync(stagedDir, { recursive: true, mode: 0o755 });
    extract(archivePath, stagedDir);
    const stagedBinary = path.join(stagedDir, path.basename(binaryPath));
    if (!existsSync(stagedBinary)) {
      throw new Error(
        `Extract succeeded but binary missing at ${binaryPath}. ` +
          "The release archive layout may have changed.",
      );
    }
    try {
      fs.chmodSync(stagedBinary, 0o755);
    } catch {
      /* best-effort */
    }
    fs.writeFileSync(
      path.join(stagedDir, OBSCURA_VERSION_MARKER),
      `${OBSCURA_VERSION}\n`,
      { mode: 0o644 },
    );
    let movedPrevious = false;
    try {
      if (existsSync(platformDir)) {
        fs.renameSync(platformDir, backupDir);
        movedPrevious = true;
      }
      fs.renameSync(stagedDir, platformDir);
    } catch (error) {
      if (movedPrevious && !existsSync(platformDir)) {
        fs.renameSync(backupDir, platformDir);
      }
      throw error;
    }
    fs.rmSync(backupDir, { recursive: true, force: true });
    log(`Installed ${binaryPath}`);
    return { binary: binaryPath, root, skipped: null, alreadyInstalled: false };
  } finally {
    fs.rmSync(stagedDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
