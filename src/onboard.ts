// `betterwright init` — one command from nothing to a working browser.
//
// Before this, getting started meant reading a README, choosing between four
// integration shapes, running `setup`, knowing that `update` is the one that
// installs the fork, finding the right skills directory for your agent, and
// only then discovering whether any of it worked. Most of those decisions have
// a right answer that can be detected rather than asked: which agent hosts are
// on this machine, which browser this platform can run, whether the MCP peer
// dependency is present.
//
// So init detects what it can, asks only what it genuinely cannot infer, does
// the work, and finishes by driving a real page load — because "installed" and
// "working" are different claims and only the second one is worth reporting.
// It is safe to re-run: every step reports what is already done and changes
// only what is not.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";

import { cliPaint, paintedLog } from "./cli-theme.js";
import { defaultHome } from "./home.js";

const execFileAsync = promisify(execFile);

const CODEX_BEGIN_PREFIX = "<!-- betterwright:begin";
const CODEX_END = "<!-- betterwright:end -->";
function codexBeginMarker(version) {
  // Stamping the version into the marker lets `skill --status` and the
  // staleness check see whether the Codex block is current, the way the
  // skill-file frontmatter does for the other hosts.
  return version ? `${CODEX_BEGIN_PREFIX} v${version} -->` : `${CODEX_BEGIN_PREFIX} -->`;
}

/**
 * Agent hosts init knows how to wire, most-likely-first.
 * `detect` only reports presence; nothing is written without a decision.
 */
export function agentHostTargets(home = os.homedir()) {
  return [
    {
      id: "claude",
      label: "Claude Code",
      how: "skills in ~/.claude/skills (browser + e2e-review)",
      marker: path.join(home, ".claude"),
      skillTarget: "claude",
    },
    {
      id: "agents",
      label: "Agent Skills (~/.agents)",
      how: "skills in ~/.agents/skills (browser + e2e-review)",
      marker: path.join(home, ".agents"),
      skillTarget: "agents",
    },
    {
      id: "cursor",
      label: "Cursor",
      how: "skills in ~/.cursor/skills (browser + e2e-review)",
      marker: path.join(home, ".cursor"),
      skillTarget: "cursor",
    },
    {
      id: "codex",
      label: "Codex",
      how: "instructions appended to ~/.codex/AGENTS.md",
      marker: path.join(home, ".codex"),
      codexFile: path.join(home, ".codex", "AGENTS.md"),
    },
  ];
}

export function detectAgentHosts(home = os.homedir()) {
  return agentHostTargets(home).map((target) => ({
    ...target,
    present: fs.existsSync(target.marker),
  }));
}

/**
 * Write the skill between markers in an instructions file Codex reads, so
 * re-running init updates the block instead of stacking copies of it.
 *
 * This edits a file the user owns — their *global* Codex instructions — so it
 * fails loud rather than guessing when the markers are not a single clean
 * pair. A previous version matched the first begin against the first end; an
 * orphaned begin marker (or a second run over an appended block) then spliced
 * out everything between, destroying user text. The rules here:
 *   - exactly one begin and one end, end after begin → replace that span;
 *   - no markers at all → append a fresh block;
 *   - anything else (orphan, reversed, duplicated) → throw, touch nothing.
 * The write is atomic (temp + rename) so a crash mid-write cannot truncate the
 * file to nothing.
 *
 * @returns {"created"|"updated"|"unchanged"}
 */
export function upsertCodexInstructions(
  file,
  body,
  { version = null }: any = {},
) {
  const begin = codexBeginMarker(version);
  const block = `${begin}\n${String(body).trim()}\n${CODEX_END}\n`;
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    atomicWriteFileSync(file, block);
    return "created";
  }

  // Match a begin marker regardless of the version it carries, so an upgrade
  // replaces last release's block instead of appending beside it.
  const beginMatches = [...existing.matchAll(/<!-- betterwright:begin[^\n]*-->/g)];
  const endMatches = [...existing.matchAll(/<!-- betterwright:end -->/g)];

  if (beginMatches.length === 0 && endMatches.length === 0) {
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    atomicWriteFileSync(file, `${existing}${separator}${block}`);
    return "updated";
  }

  const start = beginMatches[0]?.index;
  const endMatch = endMatches[0];
  const balanced =
    beginMatches.length === 1 &&
    endMatches.length === 1 &&
    start != null &&
    endMatch.index > start;
  if (!balanced) {
    throw new Error(
      `${file} has BetterWright markers that are not a single clean pair ` +
        `(${beginMatches.length} begin, ${endMatches.length} end). Refusing to ` +
        "edit it automatically so nothing between them is lost. Remove the stray " +
        `\`${CODEX_BEGIN_PREFIX} …-->\` / \`${CODEX_END}\` lines and re-run.`,
    );
  }

  const endAt = endMatch.index + endMatch[0].length;
  const replaced = existing.slice(0, start) + block.trimEnd() + existing.slice(endAt);
  if (replaced === existing) return "unchanged";
  atomicWriteFileSync(file, replaced);
  return "updated";
}

/** Write via a sibling temp file and rename, so a crash never truncates. */
function atomicWriteFileSync(file, contents) {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.${path.basename(file)}.betterwright-${process.pid}.tmp`);
  fs.writeFileSync(temp, contents);
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** Is the MCP peer dependency importable from here or the working directory? */
export async function mcpSdkAvailable() {
  try {
    const { importOptionalPeer } = await import("./optional-peer.js");
    await importOptionalPeer("@modelcontextprotocol/sdk/server/mcp.js", "The MCP server");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

/** Is `claude` on PATH, so we can offer to register the MCP server for them? */
async function claudeCliAvailable() {
  try {
    await execFileAsync(process.platform === "win32" ? "where" : "which", ["claude"], {
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

function createPrompter({ interactive, log }) {
  if (!interactive) {
    return {
      async ask() {
        return null;
      },
      async confirm(_question, fallback = true) {
        return fallback;
      },
      close() {},
    };
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    async ask(question) {
      return new Promise((resolve) => rl.question(question, (answer) => resolve(answer)));
    },
    async confirm(question, fallback = true) {
      const suffix = fallback ? "[Y/n]" : "[y/N]";
      const answer = String(await this.ask(`${question} ${suffix} `)).trim();
      if (!answer) return fallback;
      return /^y(es)?$/i.test(answer);
    },
    close() {
      rl.close();
    },
    log,
  };
}

// --- First-run onboarding -------------------------------------------------
//
// A bare `betterwright` is the most likely first command someone ever runs,
// and without a browser installed the console can only fail on its first
// task. So the console checks a one-time marker in the BetterWright home and,
// when nothing is installed yet, offers the same guided init before starting.
// The marker (not readiness) is the gate so the offer happens at most once:
// declining it is remembered, and someone who set up by hand never sees it.

export function firstRunMarkerPath(home = defaultHome()) {
  return path.join(home, "first-run.json");
}

function writeFirstRunMarker(home, version, setup) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    firstRunMarkerPath(home),
    `${JSON.stringify({ setup, version, at: new Date().toISOString() }, null, 2)}\n`,
  );
}

// The welcome card follows the bast.sh first-run look: a rounded box, one
// accent glyph beside a bold title, a one-line pitch, then a legend whose
// markers carry the accent while the text stays dim. Painted here rather than
// at the log sink because box-drawing rows match none of the status-glyph
// patterns paintedLog knows.
export function welcomeCardLines(paint = cliPaint()) {
  const rows = [
    {
      text: "◆  Welcome to BetterWright",
      render: `${paint.accentBold("◆")}  ${paint.bold("Welcome to BetterWright")}`,
    },
    { text: "" },
    { text: "A persistent, policy-guarded browser for your coding agents." },
    { text: "" },
    { text: "First run: the managed browser is not installed yet." },
    { text: "Guided setup takes about a minute:" },
    { text: "" },
    ...[
      ["1", "download the managed browser (~200 MB, once)"],
      ["2", "wire the coding agents found on this machine"],
      ["3", "verify everything with a real page load"],
    ].map(([key, what]) => ({
      text: `${key}   ${what}`,
      render: `${paint.accent(key)}   ${paint.dim(what)}`,
    })),
  ];
  const width = Math.max(...rows.map((row) => row.text.length));
  const bar = "─".repeat(width + 2);
  return [
    paint.dim(`╭${bar}╮`),
    ...rows.map((row) => {
      const pad = " ".repeat(width - row.text.length);
      return `${paint.dim("│")} ${row.render ?? paint.dim(row.text)}${pad} ${paint.dim("│")}`;
    }),
    paint.dim(`╰${bar}╯`),
  ];
}

/**
 * Offer guided setup on the first interactive console launch.
 * Returns null to continue into the console, or an exit code when the accepted
 * setup failed (a console with no browser would only fail more confusingly).
 *
 * @param {object} options
 * @param {string} options.home BetterWright home (marker location)
 * @param {boolean} options.isTTY both stdin and stdout are terminals
 * @param {Function} options.doctorReport
 * @param {Function} options.runInit async () => number, the wired `init` command
 * @param {Function} [options.confirm] async (question) => boolean, for tests
 */
export async function maybeOfferFirstRunSetup({
  home = defaultHome(),
  isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY),
  doctorReport,
  runInit,
  version = null,
  log = paintedLog(cliPaint()),
  confirm = null,
}: any = {}) {
  // Scripted and piped invocations must never block on a prompt.
  if (!isTTY) return null;
  if (fs.existsSync(firstRunMarkerPath(home))) return null;
  const report = await doctorReport();
  if (report.ready) {
    // Set up by hand before ever opening the console. Record that quietly so
    // later launches skip the doctor check.
    writeFirstRunMarker(home, version, "already-ready");
    return null;
  }
  const paint = cliPaint();
  log("");
  for (const line of welcomeCardLines(paint)) log(`  ${line}`);
  log("");
  let accepted;
  const question = `  ${paint.accent("▸")} Run guided setup now?`;
  if (confirm) {
    accepted = await confirm(question);
  } else {
    const prompt = createPrompter({ interactive: true, log });
    try {
      accepted = await prompt.confirm(question, true);
    } finally {
      prompt.close();
    }
  }
  if (!accepted) {
    // Remembered: the console never asks twice. `betterwright init` stays
    // available for when they want it.
    writeFirstRunMarker(home, version, "declined");
    log("  Skipping setup. Run `betterwright init` anytime for the guided path.");
    log("");
    return null;
  }
  const code = await runInit();
  if (code !== 0) return code; // no marker: a failed download should offer again
  writeFirstRunMarker(home, version, "completed");
  return null;
}

/**
 * @param {object} options
 * @param {Set<string>} options.flags CLI flags
 * @param {Function} options.installBrowser async () => number, the setup path
 * @param {Function} options.doctorReport
 * @param {Function} options.installAgentSkills
 * @param {Function} options.skillMarkdown () => string
 * @param {Function} options.skillBody () => string
 * @param {Function} options.verify async () => {ok, detail}
 */
export async function runInit({
  flags = new Set(),
  installBrowser,
  doctorReport,
  installAgentSkills,
  skillMarkdown,
  skillBody,
  verify,
  version = null,
  home = os.homedir(),
  log = paintedLog(cliPaint()),
}: any = {}) {
  const assumeYes = flags.has("--yes");
  const interactive = !assumeYes && Boolean(process.stdin.isTTY);
  const prompt = createPrompter({ interactive, log });
  const done = [];
  const notes = [];

  try {
    log("");
    log(cliPaint().heading("Setting up BetterWright."));
    log("");

    // 1. Runtime. Nothing below can work without it, and the failure is much
    // clearer here than as a syntax error three layers down.
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 22) {
      log(`  ✗ Node ${process.versions.node} — BetterWright needs Node 22 or newer.`);
      log("    Install it from https://nodejs.org and run `betterwright init` again.");
      return 1;
    }
    log(`  ✓ Node ${process.versions.node}`);

    // 2. Browser.
    if (flags.has("--skip-browser")) {
      log("  · Browser: skipped (--skip-browser)");
    } else {
      const before = await doctorReport();
      if (before.ready) {
        log(`  ✓ Browser already installed (${before.browser})`);
      } else {
        log("  · Downloading the managed browser (~200 MB, once)…");
        const code = await installBrowser();
        if (code !== 0) {
          log("  ✗ The browser download failed. Fix the error above, then re-run `betterwright init`.");
          return code;
        }
        const after = await doctorReport();
        log(
          after.ready
            ? `  ✓ Browser installed (${after.browser})`
            : "  ! Browser installed but doctor is still unhappy — run `betterwright doctor`.",
        );
      }
    }

    // 3. Agent wiring. Detected hosts are the default; init never writes into a
    // host the user does not actually have.
    if (flags.has("--skip-agents")) {
      log("  · Agent setup: skipped (--skip-agents)");
    } else {
      const hosts = detectAgentHosts(home);
      const present = hosts.filter((host) => host.present);
      if (!present.length) {
        log("  · No agent hosts detected on this machine.");
        notes.push(
          "No agent host was detected. When you have one, run `betterwright skill --install`, " +
            "or `betterwright skill` to print instructions you can paste anywhere.",
        );
      } else {
        log("");
        log(`  Found ${present.length} agent host${present.length === 1 ? "" : "s"}:`);
        for (const host of present) log(`    • ${host.label} — ${host.how}`);
        // Writing into ~/.claude, ~/.cursor, ~/.agents, and the user's global
        // ~/.codex/AGENTS.md is consent-worthy. On a TTY we ask; without one we
        // proceed only when the user said `--yes`, rather than silently
        // editing config a piped/CI caller had no chance to decline.
        const wire = interactive
          ? await prompt.confirm("  Wire BetterWright into them?", true)
          : assumeYes;
        if (!wire) {
          notes.push(
            interactive
              ? "Skipped agent wiring. Run `betterwright skill --install` when you want it."
              : "Skipped agent wiring (no terminal to confirm at). Re-run with --yes, " +
                  "or run `betterwright skill --install`.",
          );
        } else {
          // One unwritable host must not abort the others or skip verification.
          // A read-only ~/.claude used to throw EACCES straight out of init,
          // leaving Codex unwired and the browser unverified.
          const skillTargets = present.filter((host) => host.skillTarget).map((h) => h.skillTarget);
          if (skillTargets.length) {
            try {
              const { written } = installAgentSkills({
                markdown: skillMarkdown(),
                targets: skillTargets,
              });
              for (const file of written) log(`  ✓ ${file}`);
              if (written.length) done.push(`${written.length} skill file(s)`);
            } catch (error) {
              log(`  ! Could not write one or more skill files: ${error?.message || error}`);
              notes.push("Some agent skill files could not be written. Fix the permissions and re-run.");
            }
          }
          const codex = present.find((host) => host.codexFile);
          if (codex) {
            try {
              const outcome = upsertCodexInstructions(codex.codexFile, skillBody(), { version });
              log(
                outcome === "unchanged"
                  ? `  ✓ ${codex.codexFile} (already current)`
                  : `  ✓ ${codex.codexFile} (${outcome})`,
              );
              done.push("Codex instructions");
            } catch (error) {
              log(`  ! Could not update ${codex.codexFile}: ${error?.message || error}`);
              notes.push(`Update Codex manually: append \`betterwright skill\` output to ${codex.codexFile}.`);
            }
          }
        }
      }

      // MCP is an alternative to the skill, not a requirement, so it is only
      // offered — and only when it would actually work.
      const claudePresent = hosts.find((host) => host.id === "claude")?.present;
      if (claudePresent && (await claudeCliAvailable())) {
        const sdk = await mcpSdkAvailable();
        if (sdk.ok) {
          const wantMcp = interactive
            ? await prompt.confirm(
                "  Also register the MCP server with Claude Code? (the skill already works without it)",
                false,
              )
            : false;
          if (wantMcp) {
            try {
              await execFileAsync("claude", ["mcp", "add", "betterwright", "--", "npx", "betterwright", "mcp"], {
                timeout: 30_000,
              });
              log("  ✓ MCP server registered with Claude Code");
              done.push("MCP registration");
            } catch (error) {
              log(`  ! Could not register the MCP server: ${error?.message || error}`);
              notes.push("Register MCP manually: claude mcp add betterwright -- npx betterwright mcp");
            }
          }
        } else {
          notes.push(
            "MCP is available but needs its SDK: `npm install -g @modelcontextprotocol/sdk`, " +
              "then `claude mcp add betterwright -- npx betterwright mcp`. The skill works without it.",
          );
        }
      }
    }

    // 4. Verify. "Installed" and "working" are different claims.
    let verified = false;
    if (flags.has("--skip-browser")) {
      log("  · Verification: skipped (--skip-browser)");
    } else {
      log("");
      log("  · Checking that the browser actually loads a page…");
      const result = await verify();
      for (const warning of result.warnings || []) log(`    ! ${warning}`);
      if (result.ok) {
        log(`  ✓ Loaded a real page (${result.detail})`);
        verified = true;
      } else if (result.launched) {
        // The browser started but the page did not load — offline, a proxy, a
        // blocked example.com. The install is fine; do not fail the whole run
        // over the network, but say plainly what could not be confirmed.
        log(`  ! The browser launched but could not load a test page: ${result.detail}`);
        notes.push(
          "Could not confirm a live page load (offline or network-restricted?). " +
            "The install looks fine; re-run `betterwright doctor` once you have network.",
        );
      } else {
        log(`  ✗ The browser could not start: ${result.detail}`);
        log("    Run `betterwright doctor` for the full picture.");
        return 1;
      }
    }

    log("");
    // Don't claim "ready" for a run that verified nothing. With the browser
    // and verification skipped, init only wired agents; say that instead.
    log(verified ? "BetterWright is ready." : "BetterWright setup steps completed.");
    if (!verified && flags.has("--skip-browser")) {
      log("  (Browser install and verification were skipped — run `betterwright doctor` to confirm.)");
    }
    log("");
    if (done.length) {
      log("  Ask your agent to browse something — it knows how now.");
      log("  Or drive it yourself:");
    } else {
      log("  Drive it from a shell:");
    }
    log("    betterwright run -c \"await page.goto('https://example.com'); return page.title()\"");
    log("");
    const { preferredModelId } = await import("./doctor.js");
    const model = preferredModelId();
    if (model.configured) {
      log(`  Or hand it a whole task — ${model.reason}, so this works now:`);
      log('    betterwright exec "find the top Hacker News story"');
    } else {
      log("  To hand it whole tasks in plain language it also needs a model:");
      log("    betterwright auth --login codex     # or set ANTHROPIC_API_KEY");
      log('    betterwright exec "find the top Hacker News story"');
    }
    log("");
    log("  Saved passwords:  betterwright vault list");
    log("  Other browsers:   betterwright configure   (cloud providers, custom CDP)");
    log("  Anything wrong:   betterwright doctor");
    for (const note of notes) {
      log("");
      log(`  Note: ${note}`);
    }
    log("");
    return 0;
  } finally {
    prompt.close();
  }
}
