# Security

BetterWright hands a browser to automated, sometimes model-authored, code. Its
threat model and the controls that enforce it are documented in
[docs/architecture.md](docs/architecture.md#security-model). In short:

- **The network floor** (metadata endpoints and private networks blocked at the
  resolver, transport proxy, and policy layers) is the real boundary and fails
  closed.
- **The sandbox** removes the escape-hatch APIs from model code as defense in
  depth. It is not, and does not claim to be, a `node:vm` security boundary.
- **The credential vault** encrypts records at rest, URL-gates login lookup,
  fills detected forms without returning secrets, and redacts handled values
  from outputs. The filled value still exists in the matched page's DOM, and
  the local key file does not defend against an attacker who can already read
  files as the same OS user. External vault adapters remain available for a
  stronger key-management boundary.

Please read those sections before deploying BetterWright somewhere it can be
driven by untrusted input.

## Live View security

Live View is a trusted host capability, not part of the model-authored code
sandbox. It starts only through an explicit host, agent handoff, or user action
and remains immutably bound to one BetterWright session.

The no-config Direct viewer listens only on `127.0.0.1`. LAN and Tailscale
listeners must be selected explicitly. Direct URLs contain a random capability;
an optional eight-character-minimum password is stored as a salted scrypt
verifier. Direct HTTP still needs a trusted LAN, tailnet, SSH tunnel, or HTTPS
tunnel for transport privacy.

The managed relay connects outbound to `live.betterwright.com` and keeps the
host address out of the viewer. Screen frames, input, and chat are encrypted
between the BetterWright host and viewer with directional HKDF-derived
AES-256-GCM keys. The root key stays in the viewer URL fragment and is not sent
to the relay. Authenticated epochs and sequence numbers reject tampering and
replay, and an encrypted host challenge gates all viewer input after every
connection.

Cloudflare can still observe normal service metadata such as account/session
identifiers, connection timing, peer IP metadata, and ciphertext sizes. D1
stores HMAC digests for API keys and capabilities, never their plaintext or the
viewer root. A complete viewer URL grants the access shown by the page, so do
not log or paste it into model prompts, tickets, or chats. Revoke personal API
keys at <https://betterwright.com/account> when no longer needed.

The website is an account-management surface only. Managed viewer HTTPS and
WebSocket traffic goes directly to Cloudflare and does not traverse the Azure
website origin. See [docs/live-view.md](docs/live-view.md) and the
[managed relay protocol](https://github.com/BetterWright/betterwright/blob/main/relay/docs/PROTOCOL.md)
for protocol and operational details.

## Reporting a vulnerability

Report suspected vulnerabilities privately via GitHub's **Report a
vulnerability** flow (Security → Advisories) on the repository, rather than
opening a public issue. Please include a description, affected version, and a
minimal reproduction. We aim to acknowledge reports within a few days.

Because the network floor is the boundary we rely on, a way to reach a blocked
metadata endpoint or private address from inside a `run()` snippet — bypassing
the resolver rules, the transport proxy, and the policy — is the highest-severity
class of report.
