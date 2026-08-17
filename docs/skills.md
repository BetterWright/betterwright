# Skill packs

Whoever drives the browser needs more than the mechanics of the browser. One
static operator prompt can teach a model to observe, act, and verify, but it
cannot carry the specifics of every site and password manager without bloating
every request. Skill packs solve that — small Markdown files read **on demand**,
only when a page or task makes them relevant.

They serve both shapes BetterWright is used in. **Integrated**, a host agent
(Claude Code, Codex, a Pi package, any MCP client) reads a pack as a plain file
with the file tool it already has. **Standalone**, BetterWright's own agent loop
— `betterwright exec`, the interactive console, `runAgentTask()` — reads the
same packs from the same directories. One set of files, one format, either
driver.

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

Every run result — and every observation the built-in loop feeds its model —
carries a `skills` array listing packs whose `autoInject.url` patterns match any
open page:

```json
{
  "ok": true,
  "pages": [{ "url": "https://github.com/o/r/pull/1", "active": true }],
  "skills": [
    { "name": "github", "description": "GitHub navigation…", "path": "/…/skills/github/SKILL.md" }
  ]
}
```

The operator prompt — the same text `betterwright skill` prints and the built-in
loop runs on — tells whoever is driving to read the named `path` (with its own
file tool, or `betterwright skills show <name>`) before improvising site-specific
behavior, and to read the `credential-manager` pack before any login, signup,
or checkout.

The built-in loop has one extra path in: a pack whose `autoInject.keywords`
match the task text is loaded into that run's system prompt before the first
step, so guidance the task plainly needs costs no round-trip to fetch.

## Packaged and user packs

Packaged packs ship in the npm package's `skills/`:

- `credential-manager` — the source-order ladder for logins, signups, password
  changes, and payments, and the rules that keep secrets out of the transcript.
- `1password`, `bitwarden` — provider packs encoding the inline-menu detection
  heuristics, extension popup URLs, and unlock-then-reload flows.
- `github` — a lean site pack (canonical URLs, working style, shortcuts).
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
