# AsideWright parity — design notes

BetterWright and Aside solve the same problem: give a language model a browser
it can drive safely. Aside ("AsideWright" is its browser runtime) is the current
state of the art. This note records, from a study of the local Aside daemon and
its skill/memory system, what makes it capable, and how BetterWright closes the
gap **without changing what BetterWright is**: an add-on that a host agent
(Claude Code, Codex, a Pi package, any MCP client) drives. The host keeps doing
the asking, remembering, and sub-agenting; BetterWright gives that host the tool
surface and knowledge to be as capable as Aside.

## Scope decisions

- **No standalone agent features.** BetterWright does not gain its own
  ask-user, memory, or subagent tools. Those belong to the host. Where Aside's
  capability comes from such a feature, BetterWright instead *steers the host's*
  equivalent through the operator prompt.
- **No injecting into the user's existing Chrome sessions or tabs.** BetterWright
  keeps its own managed CloakBrowser persistent profile. Aside attaches to the
  user's live tabs (`listBrowserTabs`/`attachBrowserTab`); we deliberately do
  not. Logins persist in *our* profile instead.
- **Keep the hard secret boundary.** Aside redacts password fields in snapshots
  and hands out opaque password refs, but a model snippet could still read a
  filled value via `page.evaluate`. BetterWright's stronger guarantee — secret
  fill happens outside the model's sandbox entirely — stays. We widen *what* the
  trusted path can do and *who* can trigger it, not the boundary.

## What Aside does well (from the runtime study)

- **One REPL primitive, tight loop.** `snapshot(page, {interactive})` →
  `{tree, diff}`; the prompt enforces "tree first, then always diff after an
  action," "an action is unconfirmed until a fresh snapshot shows it," "no
  redundant sleeps," and a reading-escalation ladder. BetterWright already
  matches this: `snapshot({interactive})` → full → wait → `screenshot({annotate})`,
  `snapshot({diff:true})` as the verification primitive, ref discipline, and the
  same recovery ladder are all in `agentSystemPrompt()`.
- **Credential manager as a first-class REPL surface.** `passwordManager` with
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

### 3. Credentials v2 — planned
The current vault stores logins only and exposes trusted fill **only through the
JS SDK** (`bw.fillCredential`); neither the MCP server nor the Pi package can
fill. Plan, backwards-compatible with the pluggable `vault.handleRequest`
contract:
- **Categories.** Let `save`/`list`/`update` carry a `category`
  (`login|credit-card|identity|api-credential|secure-note|ssh-key`) and
  category-appropriate non-secret metadata. Login stays the default.
- **Search.** `credentials.list({text, category})` filters within the origin;
  metadata only, never secrets — matching today's redaction.
- **Autofill by item.** A trusted `bw.autofillCredential({id, fields})` /
  `autofillItem` that fills a saved login or card into the page (including
  hosted card iframes) via the existing outside-the-sandbox fill path, returning
  only `{filled}`.
- **Expose fill through every consumer.** Add a trusted, approval-appropriate
  credential-fill tool to the MCP server and the Pi package so all three
  embeddings — not just the SDK — can log in. The fill still runs as a dedicated
  worker message, never as model JS, so the secret boundary holds.
- **Opaque generated refs.** `generateAndFillCredential` already generates,
  fills, and saves without returning the secret; document it as the signup path
  and add update-after-change to avoid duplicate records.

### 4. Password-manager extension in the managed profile — planned
The provider skills assume a 1Password/Bitwarden extension is present and
unlocked. That means loading an extension into BetterWright's **own** persistent
profile (via CloakBrowser's extension support / `--load-extension` equivalent),
not touching the user's Chrome. Design: an opt-in `extensions` option listing
unpacked extension paths; document the one-time unlock in the headed profile;
keep the network policy and sandbox intact.

### 5. Passkeys — planned
No real profile, so use the CDP **WebAuthn virtual authenticator**
(`WebAuthn.enable` + `addVirtualAuthenticator`, Playwright 1.61+ exposes this).
A `passkeys` global to add/remove a virtual authenticator, seed a credential
from the vault, and toggle user-verification — enough to register and sign in
with a passkey. Secrets (the private key) stay in the vault/daemon.

### 6. Memory — out of scope for the library
Aside's layered memory (L1/semantic/episodic + "dreaming") is an agent feature.
BetterWright's contribution is the seam the provider skills already use: defer
to host/user preference (e.g. which password source) rather than hardcoding.

## Verification

Parity is proven by physical head-to-head runs, not on paper — see
`benchmarks/`. Identical tasks (a login via the provider skill, a form fill, a
multi-tab read) run in both runtimes, comparing success, wall-clock, and token
efficiency.
