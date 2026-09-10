# Skill packs

Whoever drives the browser needs more than the mechanics of the browser. One
static operator prompt can teach a model to observe, act, and verify, but it
cannot carry the specifics of every site and password manager without bloating
every request. Skill packs are small Markdown files loaded selectively when
a page or task makes them relevant.

They serve both shapes BetterWright is used in. **Integrated**, a host agent
(Claude Code, Codex, a Pi package, any MCP client) reads a pack as a plain file
with the file tool it already has. **Standalone**, BetterWright's own agent loop
— `betterwright exec`, the interactive console, `runAgentTask()` — reads the
same packs from the same directories when their keywords match the task.
External hosts can read packs on demand; the built-in loop currently loads
matching bodies only at task start. One set of files and one format serve
either driver, with different loading paths.

## What a pack looks like

A skill is a directory with a `SKILL.md`:

```markdown
---
name: github
description: GitHub navigation, review, and account-context guidance.
siteSpecific: true
autoInject:
  keywords: ["github"]
  url: ["github.com", "gist.github.com"]
---
# GitHub

## Canonical URLs
...
```

- `name` (required) — lowercase-hyphen-case, matching the directory.
- `description` (required) — the primary "read this when…" trigger the agent
  sees before opening the pack.
- `autoInject.url` — host or `host/path/**` glob patterns. When an open page
  matches, the pack is surfaced in that run's result (see below).
- `autoInject.keywords` — phrases in the task text that suggest the pack.
- `siteSpecific` — marks per-site guidance.

Keep `SKILL.md` short; link sibling `./reference.md` files for depth so the
agent pulls detail in only when it needs it.

## How an agent finds them

When packs' `autoInject.url` patterns match an open page in the session, run
results include a `skills` array of metadata hints. The built-in loop forwards
these hints in its observations. When no packs match, the field is omitted:

```json
{
  "ok": true,
  "pages": [{ "url": "https://github.com/o/r/pull/1", "active": true }],
  "skills": [
    { "name": "github", "description": "GitHub navigation…", "path": "/…/skills/github/SKILL.md" }
  ]
}
```

The browser guidance tells whoever is driving to read relevant packs before
improvising site-specific behavior, and to read `credential-manager` before
login, signup, or checkout. An external host can read the named `path` with its
file tool or run `betterwright skills show <name>`.

The built-in loop instead loads packs whose `autoInject.keywords` match the
task text into the system prompt before the first step, so guidance the task
plainly needs costs no round-trip to fetch. It has no file, shell, or skill-read
tool: a URL hint encountered later does not load that pack's body on demand.
For standalone use, give a relevant pack task keywords rather than relying
only on URL matching.

## Packaged and user packs

Packaged packs ship in the npm package's `skills/`:

- `credential-manager` — the source-order ladder for logins, signups, password
  changes, and payments, and the rules that keep secrets out of the transcript.
- `1password`, `bitwarden` — provider packs encoding the inline-menu detection
  heuristics, extension popup URLs, and unlock-then-reload flows.
- `github` — a lean site pack (canonical URLs, working style, shortcuts).
- `browser-console` — bounded console/error history for matching debugging
  tasks, without replaying a failed action just to attach listeners.
- `checkout-verification` — cart quantities and fresh transaction outcomes.
  Matching tasks also receive the built-in loop's bounded independent
  [completion check](agent.md), including read-only checkout analysis.
- `full-stack-e2e-review` — a host playbook for end-to-end product review.
  `betterwright skill --install` writes it next to the browser skill. Hosts
  keep only its name and description in context; the body loads when the user
  asks for an e2e review. It has no `autoInject` keywords or URLs, so the
  standalone browser loop and MCP result hints never pull it in.

Add your own under `$BETTERWRIGHT_HOME/skills/<name>/SKILL.md`; a user pack
overrides a packaged one with the same name. List everything with
`betterwright skills list`.

## CLI

```bash
betterwright skills list          # name + description, one per line
betterwright skills show github   # print a pack's body
```

The programmatic API (`listSkills`, `readSkill`, `matchSkillsForUrl`,
`matchSkillsForText`, `skillHintsForPages`, `parseSkillDocument`) is exported
from the package root for hosts that want to surface packs their own way.
