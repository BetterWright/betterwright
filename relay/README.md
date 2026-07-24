# BetterWright Cloudflare relay

A standalone Cloudflare Worker service for BetterWright live view. It pairs one
BetterWright host with one browser viewer through a per-session Durable Object.
The relay sees message sizes, timing, account/session identifiers, and normal
Cloudflare connection metadata, but it does not receive the viewer root key and
cannot decrypt frames, browser input, chat, or BetterWright protocol controls.

This directory is independent of the parent BetterWright package. Nothing here
deploys itself.

## What is enforced

- Clerk session JWTs protect account, usage, and API-key endpoints.
- BetterWright API keys have the format `bw_live_<id>_<secret>`. D1 stores only a
  role-separated HMAC-SHA-256 digest, never the secret or complete credential.
  An account can have at most five active keys; a D1 trigger makes that limit
  race safe. A new key's complete value is returned once.
- CLI session creation and session management require a BetterWright API key.
- One `RelaySession` Durable Object exists per session, one `UserQuota` object
  per Clerk user, and one `BudgetWindow` object per billing window.
- The default weekly viewer allowance is exactly 7,200 connected seconds. ISO
  weeks begin Monday at 00:00 UTC. Host-only time and idle sessions do not
  consume viewer time.
- A viewer receives at most a 15-minute lease. The viewer automatically
  reconnects and re-challenges at a lease boundary if quota and budget remain.
  Usage is the accepted viewer-WebSocket interval, clamped to the lease, and is
  settled on disconnect. Frames sent, host connection time, and session age are
  not billing signals.
- Only one active viewer lease can exist for an account, even across sessions.
- Every admitted lease reserves a conservative $0.0025 estimate in the current
  `BudgetWindow`. A serialized reservation cannot take the default relay total
  above $900 for that billing window.
- A persistent admin kill switch and an environment kill switch deny new relay
  admission. Enabling the persistent switch also signals active session objects;
  any connection not reached by that best-effort fan-out is still bounded by its
  current 15-minute lease and cannot reconnect.
- One host and one viewer are accepted per session. WebSockets use Cloudflare's
  hibernation API and store rate/lease metadata in socket attachments.
- Peer payloads must be binary and at most 2 MiB. Default token buckets allow 15
  messages per second sustained, 20 burst, and 10 Mbps per sender. Slow peers
  are closed rather than accumulating unbounded queues.
- CORS reflects only the exact configured app origin. Viewer WebSockets require
  the exact relay origin. No wildcard or suffix origin matching is used.
- The relay code does not log frames, input, chat, ciphertext, API keys,
  capabilities, roots, or WebSocket subprotocol headers. Wrangler observability
  is disabled in the template.

All numeric policy defaults are environment-overridable. Raising a security
limit weakens the reviewed defaults and should be treated as a policy change.

## End-to-end channel

The CLI calls `prepareRelaySession()` locally to create a random session ID, a
32-byte base64url root, and the viewer proof derived from both. It sends only
the session ID and proof to `POST /v1/sessions`; the root never enters an HTTP
request or response. Session creation returns a one-time host WebSocket
capability.

Only HMAC digests of the host capability and viewer proof are stored in D1 and
the session Durable Object. The viewer URL puts the root in `#k=...`; URL
fragments are not sent in HTTP requests. The page removes the fragment from the
address bar immediately after reading it.

The root derives separate AES-256-GCM keys for host-to-viewer and
viewer-to-host traffic with HKDF-SHA-256. The viewer sends an encrypted random
challenge after every connection. `HostRelayCodec` does not release viewer
input to BetterWright until it has validated that challenge and returned the
encrypted response. The relay forwards all encrypted text and JPEG messages as
opaque binary WebSocket messages.

No WebRTC API is used. The relay never gives a peer the other peer's address.
Cloudflare necessarily observes each endpoint IP and traffic metadata as the
network provider; this design prevents peer-to-peer IP disclosure, not provider
visibility.

See [docs/PROTOCOL.md](docs/PROTOCOL.md) for the byte format and host adapter
contract.

## Routes

| Route | Method | Authentication |
| --- | --- | --- |
| `/healthz` | GET | none |
| `/v1/me` | GET | Clerk session JWT |
| `/v1/me/usage` | GET | Clerk session JWT |
| `/v1/cli/me` | GET | BetterWright API key |
| `/v1/keys` | GET, POST | Clerk session JWT |
| `/v1/keys/:id` | DELETE | Clerk session JWT |
| `/v1/sessions` | POST | BetterWright API key |
| `/v1/sessions/:id` | GET, DELETE | BetterWright API key for the owning account |
| `/v1/sessions/:id/ws` | WebSocket | role capability in subprotocol |
| `/s/:id` | GET | root remains in the URL fragment |
| `/v1/webhooks/clerk` | POST | Clerk/Svix signed webhook |
| `/v1/admin/kill-switch` | GET, PUT | `ADMIN_TOKEN` bearer token |

Clerk JWTs can arrive as `Authorization: Bearer <jwt>` or the Clerk `__session`
cookie. Mutations using the cookie require the exact `APP_ORIGIN`. Verification
uses `@clerk/backend` with `authorizedParties`; a networkless Clerk PEM public
key is preferred.

### Create an API key

From the app frontend, send a Clerk session JWT:

```http
POST /v1/keys
Authorization: Bearer <clerk-session-jwt>
Content-Type: application/json
Origin: https://app.example.com

{"name":"MacBook CLI"}
```

The `secret` field in the response is the complete `bw_live_...` key and is
never available from `GET /v1/keys`.

### Create a relay session

```http
POST /v1/sessions
Authorization: Bearer bw_live_<id>_<secret>
Content-Type: application/json

{"sessionId":"bws_<client-random>","viewerProof":"<client-derived-proof>"}
```

Use `prepareRelaySession()` from `src/client/host-codec.ts` to produce those
request fields and retain its `rootKey` locally. The response returns the viewer
base URL plus `host.websocketUrl` and one-time `host.subprotocols`. The CLI
appends `#k=<rootKey>` to the viewer base URL without sending that fragment to
the relay. A later `GET /v1/sessions/:id` returns state only.

## Initial setup

Requirements: Node.js 22+, npm, a Cloudflare account with Workers, Durable
Objects, and D1, plus a Clerk application.

```bash
cd relay
npm install
cp wrangler.example.toml wrangler.toml
npx wrangler d1 create betterwright-relay
```

Put the returned D1 UUID in `wrangler.toml`. Set the two exact origins and Clerk
allowed parties. Add the production custom-domain route; do not leave
`relay.example.com` placeholders.

Create independent high-entropy secrets. Do not reuse values:

```bash
openssl rand -base64 48 | npx wrangler secret put API_KEY_HMAC_SECRET
openssl rand -base64 48 | npx wrangler secret put CAPABILITY_HMAC_SECRET
openssl rand -base64 48 | npx wrangler secret put INTERNAL_DO_SECRET
openssl rand -base64 48 | npx wrangler secret put ADMIN_TOKEN
```

For networkless Clerk verification, copy the instance's PEM JWT public key from
Clerk Dashboard, then run:

```bash
npx wrangler secret put CLERK_JWT_KEY
```

`CLERK_SECRET_KEY` is supported as a JWKS-fetching fallback but should not be
set when `CLERK_JWT_KEY` is available. Set `CLERK_AUTHORIZED_PARTIES` to a
comma-separated exact-origin allowlist and optionally set `CLERK_AUDIENCE`.

Create a Clerk production webhook endpoint at
`<PUBLIC_ORIGIN>/v1/webhooks/clerk`, subscribe it only to
`user.deleted`, and upload its signing secret:

```bash
npx wrangler secret put CLERK_WEBHOOK_SIGNING_SECRET
```

Webhook signatures are verified over the raw request body. A valid
`user.deleted` event ends the user's sessions, revokes their API keys, removes
account metadata, and asks the quota object to clear its ledger. Missing or
invalid signing configuration fails closed, including relay readiness.

Apply D1 migrations before deploying code:

```bash
npx wrangler d1 migrations apply betterwright-relay --remote
npm run check
```

Deployment is intentionally a separate operator action:

```bash
npx wrangler deploy -c wrangler.toml
```

No deployment is performed by tests or package scripts.

## Local development

Copy the template, use a local D1 database, and put development secrets in
`.dev.vars` (gitignored). `http://localhost:<port>` is accepted only for local
origin configuration.

```bash
npx wrangler d1 migrations apply betterwright-relay --local
npm run dev
npm test
npm run typecheck
```

## Kill switch

The environment switch is fail-safe configuration:

```toml
RELAY_KILL_SWITCH = "true"
```

Changing it requires a Worker configuration deployment. The persistent switch
is immediate for new admission and does not require a deployment:

```bash
curl -X PUT https://relay.example.com/v1/admin/kill-switch \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"enabled":true,"reason":"operator stop"}'
```

Disable only after the incident is understood:

```bash
curl -X PUT https://relay.example.com/v1/admin/kill-switch \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"enabled":false,"reason":"operator reopen"}'
```

If `RELAY_KILL_SWITCH=true`, the API cannot override it.

## Budget caveat

The $900 value is a **hard admission ceiling inside this relay**, based on the
configured conservative reservation per lease. It is not a Cloudflare account spending cap
and cannot guarantee that an invoice stays below $900. Actual cost
can differ from the estimate; other Workers and Cloudflare products are outside
this service; already-incurred or delayed usage may not be represented here.
Cloudflare budget alerts are informational and do not stop workloads. Keep the
relay kill switch, Cloudflare alerts, account-level monitoring, and a tested
incident procedure. Lower `BUDGET_CEILING_USD` if the account needs headroom for
anything else.

An explicit `BILLING_WINDOW_ID` pins all reservations to that identifier and
must be rotated by the operator at each real billing-period boundary. Without
it, windows are monthly UTC and anchored by
`BILLING_PERIOD_START_DAY_UTC` (1 through 28, default 1). Leases are clamped at
the boundary so each period receives its own reservation.

## Rotation and recovery assumptions

- Rotating `API_KEY_HMAC_SECRET` invalidates every existing BetterWright API
  key. Rotate with a deliberate reissue plan.
- Rotating `CAPABILITY_HMAC_SECRET` invalidates outstanding session
  capabilities. End sessions before rotating it.
- Rotating `INTERNAL_DO_SECRET` while sessions are live can make lease release
  calls fail until old leases expire. Drain sessions first.
- Anyone with the complete viewer fragment can view and, when BetterWright
  permits, control that session. Share it as a password and revoke the session
  if it leaks.
- AES-GCM protects relay payloads, not a compromised host, browser, extension,
  or endpoint OS. The Cloudflare account and Worker code remain trusted for
  availability, quota enforcement, routing, metadata handling, and serving the
  viewer JavaScript unchanged. An account compromise could replace that script
  and exfiltrate a fragment root.
- The host must use the codec and binary-only adapter in
  `src/client/host-codec.ts`, treat only relay lifecycle strings as plaintext,
  and never forward viewer input before the codec reports `viewerVerified`.
- Cloudflare's hibernating WebSocket close event is the usage settlement signal.
  A lease expiry is the conservative fail-safe if release delivery is
  interrupted.

## Explicit WebSocket close codes

| Code | Meaning |
| ---: | --- |
| 4401 | session closed |
| 4403 | capability, origin, or encrypted-channel authentication failed |
| 4404 | required peer unavailable |
| 4407 | weekly viewer quota exhausted |
| 4408 | message-rate or bandwidth limit exceeded |
| 4409 | duplicate peer or another account viewer lease is active |
| 4410 | receiver backpressure limit exceeded |
| 4411 | relay budget admission ceiling reached |
| 4412 | kill switch enabled |
| 4413 | 15-minute lease ended; viewer may reconnect to renew |
| 4414 | message exceeds configured maximum |
| 4415 | peer sent plaintext instead of an encrypted binary envelope |
| 4416 | session expired |
| 4500 | internal admission or socket state unavailable |
