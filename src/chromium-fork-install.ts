// Download + install the BetterChromium fork into the zero-config
// discovery root (~/.betterwright/chromium). Used by `betterwright update`
// and by default `betterwright setup` on platforms that ship an artifact.
//
// Pattern matches Playwright: the npm package is the driver; the
// browser zip is fetched from a pinned GitHub Release and verified
// with SHA-256 before extract. Apple-licensed fonts are intentionally not
// in the public zip (see research/assemble-mac-fonts.sh).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import {
  BETTERWRIGHT_CHROMIUM_VERSION,
  CHROMIUM_FORK_ASSETS,
  CHROMIUM_FORK_RELEASE_TAG,
  chromiumForkInstallationMatches,
  chromiumForkInstallReceipt,
  chromiumForkReceiptPath,
  defaultChromiumForkRoot,
  ensureWindowsChromiumAssembly,
  PLATFORM_LAYOUT,
} from "./chromium-fork.js";

const DEFAULT_REPO = "BetterWright/betterwright";

function platformKey(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/** Asset metadata for this host, or null when no public fork is shipped. */
export function chromiumForkAssetForHost({
  platform = process.platform,
  arch = process.arch,
} = {}) {
  return CHROMIUM_FORK_ASSETS[platformKey(platform, arch)] || null;
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
          "User-Agent": "betterchromium-install",
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
          reject(
            new Error(
              `Download failed (${status}) for ${url}. Check that release ` +
                `${CHROMIUM_FORK_RELEASE_TAG} exists and the asset is public.`,
            ),
          );
          return;
        }
        const out = fs.createWriteStream(destPath);
        pipeline(response, out).then(resolve, reject);
      },
    );
    request.on("error", reject);
  });
}

function extractZip(
  zipPath,
  destDir,
  {
    platform = process.platform,
    spawn = spawnSync,
  } = {},
) {
  fs.mkdirSync(destDir, { recursive: true, mode: 0o755 });
  if (platform === "darwin") {
    // ditto preserves macOS app bundle metadata better than unzip.
    const result = spawn(
      "ditto",
      ["-x", "-k", zipPath, destDir],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(
        `ditto extract failed: ${result.stderr || result.stdout || "unknown error"}`,
      );
    }
    return;
  }

  const command = platform === "win32" ? "tar.exe" : "unzip";
  const args = platform === "win32"
    ? ["-xf", zipPath, "-C", destDir]
    : ["-oq", zipPath, "-d", destDir];
  const result = spawn(command, args, {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} extract failed: ${result.stderr || result.stdout || "unknown error"}`,
    );
  }
}

export const _extractZipForTest = extractZip;

/**
 * Install (or refresh) the Chromium fork for this platform into
 * `~/.betterwright/chromium`. Returns `{ binary, root, skipped }` where
 * `skipped` is set when this platform has no public artifact.
 *
 * `download` / `extract` are injectable for unit tests.
 */
export async function installChromiumFork({
  home = os.homedir(),
  platform = process.platform,
  arch = process.arch,
  repo = process.env.BETTERWRIGHT_CHROMIUM_REPO || DEFAULT_REPO,
  releaseTag = process.env.BETTERWRIGHT_CHROMIUM_RELEASE_TAG ||
    CHROMIUM_FORK_RELEASE_TAG,
  force = false,
  log = console.log,
  download = downloadToFile,
  extract = extractZip,
  existsSync = fs.existsSync,
  /** Override the public asset manifest (unit tests only). */
  assets = CHROMIUM_FORK_ASSETS,
} = {}) {
  const key = platformKey(platform, arch);
  const asset = assets[key];
  if (!asset) {
    return {
      binary: null,
      root: defaultChromiumForkRoot({ home }),
      skipped: `No public BetterChromium artifact for ${key}; use the provider option for your own or a cloud browser.`,
    };
  }

  const root = defaultChromiumForkRoot({ home });
  const layout = PLATFORM_LAYOUT[key];
  const binaryPath = path.join(root, layout);
  const platformName = layout.split(path.sep)[0];
  const platformDir = path.join(root, platformName);
  const backup = path.join(root, `.previous-${platformName}`);

  // The backup has a stable, platform-specific name so a new process can
  // recover after termination between the two directory renames. Do this
  // before downloading: an offline retry must still restore the prior files.
  if (!fs.existsSync(platformDir) && fs.existsSync(backup)) {
    fs.renameSync(backup, platformDir);
    log(`Recovered BetterChromium installation after an interrupted update: ${platformDir}`);
  }

  if (!force && existsSync(binaryPath)) {
    const windowsDll = path.join(path.dirname(binaryPath), "chrome_elf.dll");
    if (platform === "win32" && !existsSync(windowsDll)) {
      log(
        `BetterChromium installation is incomplete (missing ${windowsDll}); downloading a clean copy.`,
      );
    } else if (chromiumForkInstallationMatches({ root, platform, arch, releaseTag, assets })) {
      const assembly = ensureWindowsChromiumAssembly({
        binaryPath,
        platform,
        repair: true,
        existsSync,
      });
      if (assembly.repaired) {
        log(`Repaired BetterChromium Windows side-by-side manifest: ${assembly.manifest}`);
      }
      fs.rmSync(backup, { recursive: true, force: true });
      log(`BetterChromium already installed: ${binaryPath}`);
      log(`Re-run with --force to re-download ${BETTERWRIGHT_CHROMIUM_VERSION}.`);
      return { binary: binaryPath, root, skipped: null, alreadyInstalled: true };
    } else {
      log("BetterChromium is outdated or unverified; downloading the pinned release.");
    }
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bw-chromium-"));
  const zipPath = path.join(tmpDir, asset.name);
  const url = releaseDownloadUrl(repo, releaseTag, asset.name);
  let stageRoot;

  try {
    log(`Downloading BetterChromium ${BETTERWRIGHT_CHROMIUM_VERSION}...`);
    log(`  ${url}`);
    await download(url, zipPath);

    const actual = sha256File(zipPath);
    if (actual !== asset.sha256) {
      throw new Error(
        `SHA-256 mismatch for ${asset.name}: expected ${asset.sha256}, got ${actual}`,
      );
    }
    log(`Checksum OK (${actual.slice(0, 12)}…)`);

    fs.mkdirSync(root, { recursive: true, mode: 0o755 });
    // Stage on the destination filesystem so promotion uses a directory rename.
    // An extraction/validation failure must not destroy the existing install.
    stageRoot = fs.mkdtempSync(path.join(root, `.install-${platformName}-`));
    const stagedBinary = path.join(stageRoot, layout);
    log(`Extracting into ${stageRoot} ...`);
    extract(zipPath, stageRoot);

    if (!existsSync(stagedBinary)) {
      throw new Error(
        `Extract succeeded but binary missing at ${stagedBinary}. ` +
          "The release zip layout may not match this BetterWright version.",
      );
    }
    const assembly = ensureWindowsChromiumAssembly({
      binaryPath: stagedBinary,
      platform,
      repair: true,
      existsSync,
    });
    if (assembly.repaired) {
      log(`Created BetterChromium Windows side-by-side manifest: ${assembly.manifest}`);
    }
    try {
      fs.chmodSync(stagedBinary, 0o755);
    } catch {
      /* best-effort */
    }
    const sandbox = path.join(path.dirname(stagedBinary), "chrome-sandbox");
    if (existsSync(sandbox) && platform === "linux") {
      try {
        fs.chmodSync(sandbox, 0o4755);
      } catch {
        log(
          "Note: could not setuid chrome-sandbox; if launch fails as non-root, run:",
        );
        log(`  sudo chmod 4755 ${path.join(path.dirname(binaryPath), "chrome-sandbox")}`);
      }
    }

    fs.writeFileSync(
      chromiumForkReceiptPath(stageRoot, platform, arch),
      `${JSON.stringify(chromiumForkInstallReceipt({ platform, arch, releaseTag, assets }), null, 2)}\n`,
      { mode: 0o644 },
    );
    const hadPrevious = fs.existsSync(platformDir);
    // Always put the displaced current tree in the stable recovery location.
    // Rotate an older leftover backup while the current tree is still in place.
    const olderBackup = path.join(stageRoot, "older-backup");
    let movedOlderBackup = false;
    let movedPrevious = false;
    try {
      if (fs.existsSync(backup)) {
        fs.renameSync(backup, olderBackup);
        movedOlderBackup = true;
      }
      if (hadPrevious) {
        fs.renameSync(platformDir, backup);
        movedPrevious = true;
      }
      fs.renameSync(path.join(stageRoot, platformName), platformDir);
    } catch (error) {
      try {
        if (movedPrevious) fs.renameSync(backup, platformDir);
        if (movedOlderBackup) fs.renameSync(olderBackup, backup);
      } catch {
        // Preserve all recovery files if rollback itself fails.
        const recoveryStage = stageRoot;
        stageRoot = undefined;
        throw new Error(`Could not promote BetterChromium or fully restore its prior installation; recovery files remain at ${backup} and ${recoveryStage}.`, { cause: error });
      }
      throw error;
    }
    fs.rmSync(backup, { recursive: true, force: true });
    log(`Installed ${binaryPath}`);
    return { binary: binaryPath, root, skipped: null, alreadyInstalled: false };
  } finally {
    if (stageRoot) fs.rmSync(stageRoot, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
