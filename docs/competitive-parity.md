# Capability roadmap — design notes

This note records the capability bar BetterWright aims for — a language model
that can drive a browser safely and get real work done — and how BetterWright
reaches it **without changing what BetterWright is**: an add-on that a host
agent (Claude Code, Codex, a Pi package, any MCP client) drives. The host keeps
doing the asking, remembering, and sub-agenting; BetterWright gives that host
the tool surface and knowledge to be fully capable.

## Scope decisions

- **No standalone agent features.** BetterWright does not gain its own
  ask-user, memory, or subagent tools. Those belong to the host. Where a
  capability would come from such a feature, BetterWright instead *steers the
  host's* equivalent through the operator prompt.
- **No injecting into the user's existing Chrome sessions or tabs.** BetterWright
  keeps its own managed CloakBrowser persistent profile rather than attaching to
  the user's live tabs. Logins persist in *our* profile instead.
- **Keep the hard secret boundary.** Redacting password fields in snapshots and
  handing out opaque password refs is not enough on its own — a model snippet
  could still read a filled value via `page.evaluate`. BetterWright's stronger
  guarantee — secret fill happens outside the model's sandbox entirely — stays.
  We widen *what* the trusted path can do and *who* can trigger it, not the
  boundary.

## Capability targets

- **One REPL primitive, tight loop.** `snapshot(page, {interactive})` →
  `{tree, diff}`; the prompt enforces "tree first, then always diff after an
  action," "an action is unconfirmed until a fresh snapshot shows it," "no
  redundant sleeps," and a reading-escalation ladder. BetterWright matches this:
  `snapshot({interactive})` → full → wait → `screenshot({annotate})`,
  `snapshot({diff:true})` as the verification primitive, ref discipline, and the
  recovery ladder are all in `agentSystemPrompt()`.
- **Credential manager as a first-class REPL surface.** A password manager with
  `listVaults/listItems/getItem/createItem/updateItem`, `autofillItem(page,id)`
  that fills logins *and* hosted card iframes, `generatePassword` → an opaque
  `GeneratedPasswordRef`, and `fillPassword(page, ref, passwordRef)`. Item
  categories span login, credit-card, identity, api-credential, ssh-key,
  secure-note. A `USER.md` preference chooses between the native vault and a
  connected external provider.
- **Provider + site skill packs** with `autoInject` keyword/URL triggers,
  progressive disclosure, and hub-and-spoke fallback ordering for password
  managers. **← BetterWright now has this** (`docs/skills.md`).
- **Snapshot redaction** of password fields to `[redacted]`, extension-iframe
  origin labels (`[origin="1Password"]`), frame-prefixed refs. BetterWright
  already redacts password inputs in `controls.inspect()` and includes iframe
  subtrees with `f1e2` refs.
- **Passkeys** work because the real profile has them.
- **Structured `ask_user_question`** with options. **← host's job**; the prompt
  now steers the host to ask with masked options.

## Gap-by-gap plan

### 1. Ask-user with options — DONE (prompt-level)
BetterWright is embedded in hosts that already have a question tool. The
operator prompt now tells the agent to ask through its host with short concrete
options and any secret masked ("account ending in 999"), after a `question`
screenshot. No standalone tool added.

### 2. Skill packs — DONE
`skills/` ships `credential-manager`, `1password`, `bitwarden`, `github`.
Run results carry a `skills` array of matching packs (`{name, description,
path}`); the prompt tells the agent to read the pack before improvising.
`betterwright skills list|show`. User packs in `$BETTERWRIGHT_HOME/skills`
override packaged ones. See `docs/skills.md`.

### 3. Credentials v2 — DONE
The vault stores categories (`login` by default, plus `credit-card`,
`identity`, `api-credential`, `secure-note`, `ssh-key`), supports metadata-only
`credentials.list({text, category})` search, and fills through every consumer:
`bw.fillCredential` in the JS SDK, `browser_login` in MCP and Pi, and the
built-in agent's `login` tool — all as a dedicated worker message, never model
JS, so the secret boundary holds. Generated credentials use the two-phase
`generateAndFill` → verify → `commitGenerated`/`discardGenerated` flow, and
rotation updates the existing record in place. Accepted logins are captured
automatically (see §4). Still open from the original plan: autofill-by-item
for non-login categories (e.g. cards into hosted iframes).

### 4. Password-manager support in the managed profile — partially DONE
BetterWright's own vault now captures logins with no extension at all: a
worker-injected CDP sensor (isolated worlds, `event.isTrusted`-gated) saves
model-typed logins silently and prompts on manual user logins in headed
sessions ("Save / Not now / Never for this site"). See
`docs/credentials.md` → Browser capture. Still planned for third-party
managers: loading an unpacked 1Password/Bitwarden extension into the managed
persistent profile (an opt-in `extensions` option), which the provider skills
assume is present and unlocked.

### 5. Passkeys — planned
No real profile, so use the CDP **WebAuthn virtual authenticator**
(`WebAuthn.enable` + `addVirtualAuthenticator`, Playwright 1.61+ exposes this).
A `passkeys` global to add/remove a virtual authenticator, seed a credential
from the vault, and toggle user-verification — enough to register and sign in
with a passkey. Secrets (the private key) stay in the vault/daemon.

### 6. Memory — out of scope for the library
Layered agent memory (session/semantic/episodic + offline extraction) is an
agent feature. BetterWright's contribution is the seam the provider skills
already use: defer to host/user preference (e.g. which password source) rather
than hardcoding.

## Verification

Capability is proven by physical head-to-head runs, not on paper — see
`benchmarks/`. Identical tasks (a login via the provider skill, a form fill, a
multi-tab read) run against a strong baseline, comparing success, wall-clock,
and token efficiency.
