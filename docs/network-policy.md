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
  can never be allowlisted; see below.
- **Blocks private and loopback addresses** — RFC 1918 ranges, `127.0.0.0/8`,
  IPv6 loopback and unique-local, link-local, and carrier-grade NAT.
- **Blocks non-web schemes** — only `http`, `https`, `ws`, and `wss` are
  routable (`about:blank`, `data:`, and `blob:` are allowed).
- **Blocks URLs that appear to carry a secret** — a query string or path holding
  something shaped like an API key or JWT is refused, so a compromised page
  cannot exfiltrate a token through a URL.
- **Allows the public internet.**

This is the right default for an agent browsing on someone's behalf: it can
reach real sites but cannot be steered into the machine's own cloud identity or
internal network.

## Opening things up

```python
from betterwright import BetterWright, NetworkPolicy

policy = NetworkPolicy(
    allow_loopback=True,                 # 127.0.0.1 and localhost
    allow_hosts=("staging.internal:8443",),  # one internal host, one port
    block_hosts=("ads.example.com",),    # deny even though it is public
)
BetterWright(policy=policy)
```

| Option | Effect |
| --- | --- |
| `allow_loopback` | Permit `127.0.0.1` / `localhost` (for local dev servers). Does **not** open the wider private network. |
| `allow_private_network` | Permit RFC 1918, link-local, and `*.internal`/`*.local` hosts. Implies loopback. |
| `allow_hosts` | Always allow these hosts. An entry matches a host exactly or as a parent domain (`example.com` also matches `sub.example.com`); add `:port` to pin a port. |
| `block_hosts` | Always block these hosts, evaluated before allowlists. |
| `block_secret_bearing_urls` | Refuse URLs that look like they carry a key/token. Default `True`. |
| `custom` | A hook, `custom(url, details) -> decision or None`, evaluated last. |

Evaluation order is: scheme check → `block_hosts` → `allow_hosts` → metadata
floor → private-network rules → `custom`.

### The custom hook

The hook receives the URL and the request `details` (`method`, `resourceType`,
`isNavigation`, and — for a resolved literal — `resolvedFrom`). Return a decision
dict to override, or `None` to keep the decision made so far.

```python
def only_get_navigations(url, details):
    if details.get("resourceType") == "document" and details.get("method") != "GET":
        return {"allowed": False, "reason": "no non-GET top-level navigations"}
    return None

NetworkPolicy(custom=only_get_navigations)
```

An `allowed: True` returned from the hook still cannot reach a metadata endpoint
— that floor is re-checked after the hook.

The JavaScript client is identical, in camelCase:

```js
new NetworkPolicy({
  allowLoopback: true,
  allowHosts: ["staging.internal:8443"],
  custom: (url, details) => (details.method === "DELETE" ? { allowed: false } : null),
});
```

## Why metadata endpoints are unliftable

A server-side agent usually runs on a cloud instance whose metadata service
(`169.254.169.254` and friends) hands out the machine's credentials to anything
that can make an HTTP request from the box. A prompt-injected page trying to
read those is one of the sharpest risks in agent browsing. So the block is not
just a policy default — it is enforced at three independent layers:

1. **Chromium resolver rules.** The browser is launched with
   `--host-resolver-rules` that map every metadata hostname and link-local range
   to `NOTFOUND` before any page loads.
2. **The transport guard.** All traffic is forced through the worker's own
   loopback SOCKS proxy (Chromium cannot bypass it, even for localhost). The
   proxy validates the connect target *and* re-validates every IP the hostname
   resolved to, so a hostname that passes cannot be swapped for a metadata
   address by DNS rebinding.
3. **The policy.** `NetworkPolicy` refuses metadata hosts and refuses to honor
   an `allow_hosts` entry or a `custom` allow that names one.

Any one of these would stop the common case; together they close the redirect
and rebinding variants too.

## Failure is closed

If the policy check itself errors — an exception in a `custom` hook, a transport
fault while resolving — the request is denied, not allowed. A broken guard must
never silently become an open browser.
