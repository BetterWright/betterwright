# Cookie Sync

Cookie Sync copies cookies from a local desktop browser into a BetterWright
browser profile. It is a trusted host operation, not a model tool. The source
profile stays unchanged, and running the same sync again replaces the same
cookie identities.

## Sync from the CLI

List the browser families supported on this operating system, then inspect the
profiles found for one family:

```bash
betterwright cookies browsers
betterwright cookies profiles chrome
```

Sync only the sites needed for the task:

```bash
betterwright cookies sync chrome \
  --source-profile "Profile 1" \
  --domain github.com \
  --domain npmjs.com \
  --profile work
```

`--domain` includes cookies on the named host, its subdomains, and parent
domains whose cookies apply to that host. Repeat it for more sites. Use
`--all` instead only when the entire source identity belongs in the target.
The CLI requires one of these scopes so an omitted flag cannot copy every
site by accident.

Persistent cookies are included by default. `--include-session` also reads
Firefox-family session stores. Chromium-family session cookies that exist
only in a running browser process cannot be recovered from its profile, so
that flag is a no-op for Chromium sources.

The selected BetterWright `--profile` is the destination. Sync fails rather
than writing into the temporary profile used after a local profile-lock
collision. Close the other BetterWright process or use its profile daemon and
retry.

Remote CLI sync and local CLI sync with `--include-session` require the session
daemon. A one-shot `--no-daemon` browser would disconnect or end a remote
session, and it would discard local session cookies when the command closed.
The CLI refuses those combinations instead of reporting unusable state as a
successful sync.

Add `--json` for a result containing counts, warning codes, source metadata,
and the target identity. Cookie names and values are never returned. The
`synced` count is verified against the target store rather than assumed from a
successful CDP call.

Before writing, BetterWright reads the target cookie jar and refuses a batch
whose projected occupancy crosses conservative Chromium limits. This avoids
triggering Chromium's per-site or global eviction. After writing, it verifies
both the imported identities and the pre-existing identities. A valid row that
the target still declines is reported as `target_not_stored`; unexpected loss
of a pre-existing identity fails the operation loudly.

## JavaScript API

```ts
import { BetterWright, listCookieSourceProfiles } from "betterwright";

const profiles = await listCookieSourceProfiles("firefox");
const browser = new BetterWright({ profile: "work" });

const result = await browser.syncCookies({
  source: { browser: "firefox", profile: profiles[0]?.id },
  domains: ["github.com"],
  includeSession: true,
});

await browser.close();
```

Omitting `domains` in the API means all compatible cookies. The explicit
`--all` requirement applies to the CLI because shell mistakes are easier to
make.

## Source support

BetterWright uses the exact-pinned optional `rookie-cookies` native reader.
It discovers profiles in their normal operating-system locations and uses the
host key store where that browser requires it.

| Source family | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Chrome, Edge, Brave, Chromium, Opera, Vivaldi and other registered Chromium browsers | Yes | Yes | Yes |
| Firefox, LibreWolf, Zen and other registered Gecko browsers | Yes | Yes | Yes |
| Safari | No | Yes | No |

`betterwright cookies browsers` is the source of truth for the current host.
Registration does not mean the browser is installed; `cookies profiles`
performs discovery. The shipped native targets are Windows x64, macOS x64 and
arm64, and glibc Linux x64 and arm64. Windows ARM64 and musl Linux currently
fail with a feature-local unavailable error instead of weakening extraction.

macOS may ask for Keychain access. Safari profile files can require Full Disk
Access. Linux Chromium decryption depends on the desktop Secret Service or
KWallet configuration used by that browser.

### Windows App-Bound cookies

Chrome-family App-Bound recovery is disabled by default. Current Chrome can
therefore report skipped `v20` rows until the caller opts in:

```bash
betterwright cookies sync chrome --domain example.com --allow-app-bound
```

The opt-in permits unprivileged reflective injection into a newly spawned
browser process. Endpoint security software can flag this technique. The
reader's elevated SYSTEM-impersonation fallback is never reachable through
BetterWright. If process injection is unacceptable on the host, leave the
flag off and sign in again for the skipped sites.

### Isolation and expiry

Chromium CHIPS cookies retain their top-level-site partition and cross-site
ancestor bit. Origin-bound Chromium cookies also retain their source scheme
and port. Firefox containers, private-browsing cookies, Firefox partition forms
that Chromium cannot represent, malformed rows, and expired rows are skipped.
BetterWright never turns an isolated cookie into an unpartitioned cookie
because that would widen where the credential can be sent.

Some sites use device-bound session credentials in addition to cookies. Those
private keys are not copied, so a site can still require authentication after
a successful sync.

## Cloud browsers

Cookie injection is available for every BetterWright remote target because
all supported providers converge on a Chromium CDP connection and its default
Playwright `BrowserContext`:

- Browser Use
- Kernel
- Browserbase
- Steel
- Anchor
- Hyperbrowser
- Browserless
- Bright Data
- Oxylabs
- custom CDP endpoints

BetterWright uses CDP `Network.setCookies` after connecting so CHIPS and
origin-bound scope survive the transfer. Cookie
values do not enter provider REST request bodies, session options, command
arguments, configuration files, the daemon socket, logs, or result envelopes.
They do cross the encrypted CDP WebSocket in plaintext at the browser endpoint.
The provider runs that browser and can inspect its memory, storage, recordings,
and network traffic. End-to-end encryption from the provider is not possible
because its Chromium process needs the cookie value to send authenticated
requests.

For that reason, each remote sync must name the exact resolved destination:

```bash
betterwright cookies sync chrome \
  --domain github.com \
  --browser browserbase \
  --allow-cloud provider:browserbase
```

For raw or custom CDP endpoints, consent is `cdp:<host>` or
`cdp:<host>:<port>`. A refused call prints the required target. BetterWright
checks it before local extraction and before a named provider can create a
billed session, then checks it again in the worker before connecting. Consent
is an argument to that one call and is never stored as a preference.

Sync persists for the life of the remote browser context. Provider-owned
profiles can persist it longer only when the caller separately configured that
provider feature. Cookie Sync does not call provider-specific profile save
APIs and does not promise cross-session persistence.

## Trust boundary

The profile daemon receives only source browser, profile, scope, and consent
options. Extraction runs inside the daemon and the cookie batch travels only
to its worker over child-process stdin. Browser-context cookie reads and
mutations, including `cookies`, `storageState`, `addCookies`, and
`clearCookies`, are absent from model-authored snippets. Full and
name-addressed request/response header methods are absent as well; Playwright's
filtered `headers()` remains available.

Cookie Sync transfers browser authority. A page can still read non-HttpOnly
cookies for its own origin through `document.cookie`, and model code driving
that page can act with the imported session. BetterWright redacts known raw
bearer-like values and serialized short cookie pairs from result envelopes,
including after restart, but model code can transform page-readable data. The
sandbox is defense in depth, not a confidentiality boundary. HttpOnly cookies
retain their normal browser protection. Scope the sync to the sites and target
profile the task actually needs.
