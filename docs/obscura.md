# Obscura resident engine

Headless BetterWright sessions use the pinned
[Obscura](https://github.com/h4ckf0r0day/obscura) release for DOM, JavaScript,
storage, cookies, and network work. The public `BetterWright` constructor and
`run()` surface do not change: existing Playwright snippets connect through the
same worker and persistent profile.

Obscura intentionally has no layout or paint engine. When `screenshot()` is
called, BetterWright launches the installed Chromium
fork (or CloakBrowser fallback) for that capture, copies the page URL, cookies,
local/session storage, controls, scroll position, and canvas buffers into it,
captures the pixels, then closes it. DOM/API-only workloads therefore do not
keep Chromium's renderer and GPU processes resident.

`betterwright setup` installs both legs. `betterwright update` refreshes only
the checksum-pinned Obscura binary under `~/.betterwright/obscura/`.
`BETTERWRIGHT_OBSCURA_PATH` and `BETTERWRIGHT_OBSCURA_ROOT` override discovery;
set either to `off` to use the previous Chromium/Cloak compatibility backend.
Headed sessions also use that compatibility backend because Obscura is
headless-only. Start live view before the first browser run when a watched
session is required; it likewise selects the visual compatibility backend.

Trusted credential helpers remain available. Automatic typed-login capture is
currently enabled on the compatibility backend only because Obscura cannot
attach the additional isolated-world sensor without duplicating its CDP target.

Every Obscura connection is loopback-only and every outbound connection is
forced through BetterWright's SOCKS policy and DNS-rebinding guard. The
on-demand pixel process uses the same guard.
