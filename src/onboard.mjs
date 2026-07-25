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

const execFileAsync = promisify(execFile);

const CODEX_BEGIN = "<!-- betterwright:begin -->";
const CODEX_END = "<!-- betterwright:end -->";

/**
 * Agent hosts init knows how to wire, most-likely-first.
 * `detect` only reports presence; nothing is written without a decision.
 */
export function agentHostTargets(home = os.homedir()) {
  return [
    {
      id: "claude",
      label: "Claude Code",
      how: "skill in ~/.claude/skills/browser",
      marker: path.join(home, ".claude"),
      skillTarget: "claude",
    },
    {
      id: "agents",
      label: "Agent Skills (~/.agents)",
      how: "skill in ~/.agents/skills/browser",
      marker: path.join(home, ".agents"),
      skillTarget: "agents",
    },
    {
      id: "cursor",
      label: "Cursor",
      how: "skill in ~/.cursor/skills/browser",
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
 * @returns {"created"|"updated"|"unchanged"}
 */
export function upsertCodexInstructions(file, body) {
  const block = `${CODEX_BEGIN}\n${String(body).trim()}\n${CODEX_END}\n`;
  let existing = "";
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, block);
    return "created";
  }
  const start = existing.indexOf(CODEX_BEGIN);
  const end = existing.indexOf(CODEX_END);
  if (start !== -1 && end > start) {
    const replaced =
      existing.slice(0, start) + block.trimEnd() + existing.slice(end + CODEX_END.length);
    if (replaced === existing) return "unchanged";
    fs.writeFileSync(file, replaced);
    return "updated";
  }
  const separator = existing.endsWith("\n") ? "\n" : "\n\n";
  fs.writeFileSync(file, `${existing}${separator}${block}`);
  return "updated";
}

/** Is the MCP peer dependency importable from here or the working directory? */
export async function mcpSdkAvailable() {
  try {
    const { importOptionalPeer } = await import("./optional-peer.mjs");
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
  home = os.homedir(),
  log = (line) => console.log(line),
} = {}) {
  const assumeYes = flags.has("--yes") || flags.has("-y");
  const interactive = !assumeYes && Boolean(process.stdin.isTTY);
  const prompt = createPrompter({ interactive, log });
  const done = [];
  const notes = [];

  try {
    log("");
    log("Setting up BetterWright.");
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
        const wire =
          interactive
            ? await prompt.confirm("  Wire BetterWright into them?", true)
            : true;
        if (!wire) {
          notes.push("Skipped agent wiring. Run `betterwright skill --install` when you want it.");
        } else {
          const skillTargets = present.filter((host) => host.skillTarget).map((h) => h.skillTarget);
          if (skillTargets.length) {
            const { written } = installAgentSkills({ markdown: skillMarkdown(), targets: skillTargets });
            for (const file of written) log(`  ✓ ${file}`);
            done.push(`${written.length} skill file(s)`);
          }
          const codex = present.find((host) => host.codexFile);
          if (codex) {
            const outcome = upsertCodexInstructions(codex.codexFile, skillBody());
            log(
              outcome === "unchanged"
                ? `  ✓ ${codex.codexFile} (already current)`
                : `  ✓ ${codex.codexFile} (${outcome})`,
            );
            done.push("Codex instructions");
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
    if (flags.has("--skip-browser")) {
      log("  · Verification: skipped (--skip-browser)");
    } else {
      log("");
      log("  · Checking that the browser actually loads a page…");
      const result = await verify();
      if (result.ok) {
        log(`  ✓ Loaded a real page (${result.detail})`);
      } else {
        log(`  ✗ The browser could not load a page: ${result.detail}`);
        log("    Run `betterwright doctor` for the full picture.");
        return 1;
      }
    }

    log("");
    log("BetterWright is ready.");
    log("");
    if (done.length) {
      log("  Ask your agent to browse something — it knows how now.");
      log("  Or drive it yourself:");
    } else {
      log("  Drive it from a shell:");
    }
    log("    betterwright run -c \"await page.goto('https://example.com'); return page.title()\"");
    log("");
    const { preferredModelId } = await import("./doctor.mjs");
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
