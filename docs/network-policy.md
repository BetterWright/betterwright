# Network policy

![The policy blocks private and metadata addresses while public traffic flows through](assets/network-policy.png)

Every request the browser makes is authorized before it goes out — page
navigations, subresources (scripts, images, XHR/fetch), WebSocket upgrades, and
the raw TCP connections the worker's transport makes on the browser's behalf.
The worker sends each one to the client as a `guard` request; the client answers
it with a `NetworkPolicy`.

## The default posture

`NetworkPolicy()` with no arguments:

- **Blocks cloud instance-metadata endpoints** — the hostnames
  `metadata.google.internal` / `metadata.goog` and the link-local addresses
  (`169.254.169.254`, `169.254.170.2`, `100.100.100.200`, `fd00:ec2::…`). These
  can never be allowlisted or disabled; see below.
- **Blocks non-web schemes** — only `http`, `https`, `ws`, and `wss` are
  routable (`about:blank`, `data:`, and `blob:` are allowed).
- **Allows the public internet, private networks, and loopback** — RFC 1918
  ranges, `127.0.0.0/8`, `localhost`, IPv6 loopback/unique-local, link-local,
  carrier-grade NAT, and `*.internal`/`*.local`/`*.lan` hosts are reachable, so
  an agent can drive local dev servers, a home router, or an intranet host
  without extra configuration.

This keeps the one non-negotiable protection — the machine's own cloud identity
is never reachable — while letting an agent browse real sites and local
infrastructure out of the box. For an agent running somewhere its private
network is sensitive, harden it:

```js
const policy = new NetworkPolicy({ allowPrivateNetwork: false, allowLoopback: false });
```

That restores the strict posture: only the public internet (plus any
`allowHosts` you name) is reachable.

## Tuning the policy

```js
import { BetterWright, NetworkPolicy } from "betterwright";

const policy = new NetworkPolicy({
  allowPrivateNetwork: false,           // harden: block RFC 1918 / intranet
  allowLoopback: true,                  // but keep 127.0.0.1 and localhost
  allowHosts: ["staging.internal:8443"], // re-allow one internal host, one port
  blockHosts: ["ads.example.com"],      // deny even though it is public
});
new BetterWright({ policy });
```

| Option | Effect |
| --- | --- |
| `allowLoopback` | Permit `127.0.0.1` / `localhost` (for local dev servers). Does **not** open the wider private network. Default `true`; set `false` to block. |
| `allowPrivateNetwork` | Permit RFC 1918, link-local, and `*.internal`/`*.local` hosts. Implies loopback. Default `true`; set `false` to block. |
| `allowHosts` | Always allow these hosts. An entry matches a host exactly or as a parent domain (`example.com` also matches `sub.example.com`); add `:port` to pin a port. |
| `blockHosts` | Always block these hosts, evaluated before allowlists. |
| `custom` | A hook, `custom(url, details)`, returning a decision or `null`, evaluated last. |

Evaluation order is: scheme check → `blockHosts` → `allowHosts` → metadata
floor → private-network rules → `custom`.

### The custom hook

The hook receives the URL and the request `details` (`method`, `resourceType`,
`isNavigation`, and — for a resolved literal — `resolvedFrom`). Return a decision
object to override, or `null` to keep the decision made so far.

```js
function onlyGetNavigations(url, details) {
  if (details.resourceType === "document" && details.method !== "GET") {
    return { allowed: false, reason: "no non-GET top-level navigations" };
  }
  return null;
}

new NetworkPolicy({ custom: onlyGetNavigations });
```

An `allowed: true` returned from the hook still cannot reach a metadata endpoint
— that floor is re-checked after the hook.

## Why metadata endpoints are unliftable

A server-side agent usually runs on a cloud instance whose metadata service
(`169.254.169.254` and friends) hands out the machine's credentials to anything
that can make an HTTP request from the box. A prompt-injected page trying to
read those is one of the sharpest risks in agent browsing. So the block is not
just a policy default — it is enforced at two independent layers:

1. **The transport guard.** All traffic is forced through the worker's own
   loopback SOCKS proxy (Chromium cannot bypass it, even for localhost). The
   proxy validates the connect target *and* re-validates every IP the hostname
   resolved to, so a hostname that passes cannot be swapped for a metadata
   address by DNS rebinding.
2. **The policy.** `NetworkPolicy` refuses metadata hosts and refuses to honor
   an `allowHosts` entry or a `custom` allow that names one.

Either layer stops the common case; together they close the redirect and
rebinding variants too.

## Failure is closed

If the policy check itself errors — an exception in a `custom` hook, a transport
fault while resolving — the request is denied, not allowed. A broken guard must
never silently become an open browser.
