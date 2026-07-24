# Relay wire protocol v1

This document is the interoperability contract between the BetterWright host
adapter and `/s/:id`. Multi-byte application values are UTF-8; relay envelopes
are raw WebSocket binary messages.

## Session material

Before session creation, the CLI locally generates:

- `sessionId`: `bws_` plus 18 random bytes encoded as unpadded base64url;
- `rootKey`: 32 random bytes encoded as unpadded base64url.

The viewer proof is:

```text
HMAC-SHA-256(
  key = base64url_decode(rootKey),
  data = UTF8("BetterWright relay viewer proof v1" || NUL || sessionId)
)
```

and is encoded as unpadded base64url. The CLI sends `sessionId` and
`viewerProof`, but not `rootKey`, to `POST /v1/sessions`. The relay creates and
returns a 32-byte random `hostCapability`. The CLI appends its retained root as
`#k=<rootKey>` to the returned viewer base URL.

The relay persists only these digests:

```text
HMAC-SHA-256(
  key = CAPABILITY_HMAC_SECRET,
  data = UTF8("betterwright-relay-capability-v1" || NUL ||
              sessionId || NUL || role || NUL || presentedCapability)
)
```

`role` is exactly `host` or `viewer`. The root never enters the relay. The host
capability and viewer proof exist transiently for verification/creation but are
not persisted; only their HMAC digests are. AES keys and full BetterWright API
keys are also never persisted.

## WebSocket authentication

Connect to `/v1/sessions/:id/ws` with exactly two ordered subprotocols:

```text
Host:   betterwright.relay.v1, bw.host.<hostCapability>
Viewer: betterwright.relay.v1, bw.viewer.<viewerProof>
```

The server selects only the non-secret `betterwright.relay.v1` protocol. A
viewer browser must send an `Origin` exactly equal to `PUBLIC_ORIGIN`. A
non-browser host can omit `Origin`; if present, it must also match exactly.

There can be one host and one viewer. The host must connect first. A viewer
connection begins quota charging only after capability, origin, host presence,
kill-switch, user quota, and budget reservation checks pass and the viewer
socket has been accepted. The preceding reservation phase is not charged.

## Key derivation

Decode the root to 32 bytes. Compute:

```text
salt = SHA-256(UTF8("BetterWright relay HKDF salt v1" || NUL || sessionId))
```

Use HKDF-SHA-256 with that salt and one of these exact info strings to derive a
non-exportable 256-bit AES-GCM key:

```text
BetterWright relay host-to-viewer AES-GCM v1
BetterWright relay viewer-to-host AES-GCM v1
```

Keys are directional. Decrypting with the opposite key or direction AAD must
fail.

## Binary envelope

Every peer message is a binary WebSocket message:

```text
Offset  Length  Meaning
0       1       version = 0x01
1       12      random AES-GCM nonce
13      rest    AES-GCM ciphertext and 16-byte tag
```

The authenticated additional data is:

```text
UTF8("BetterWright relay envelope v1" || NUL || sessionId || NUL || direction)
```

where direction is exactly `h2v` or `v2h`.

The decrypted AES-GCM plaintext begins with one protected kind byte followed by
the existing protocol bytes:

```text
0x01  BetterWright JSON text message, UTF-8
0x02  BetterWright binary payload, currently a JPEG screencast frame
0x03  relay root-key challenge JSON, UTF-8
```

The kind is encrypted. The relay does not inspect it and therefore cannot tell
a frame from input, chat, or protocol control. It forwards the complete envelope
unchanged. Nonces are fresh random 96-bit values for each message. A connection
must be closed if nonce generation fails.

The complete envelope, including version, nonce, ciphertext, and tag, must not
exceed 2 MiB under the reviewed default.

## Root-key challenge

A fresh viewer connection generates a random 16-byte unpadded-base64url nonce
and sends encrypted kind `0x03` in the viewer-to-host direction:

```json
{
  "t": "relay_challenge",
  "nonce": "<22-character-base64url>",
  "protocol": "betterwright-live-view-v1"
}
```

The host decrypts and validates it, then sends encrypted kind `0x03` in the
host-to-viewer direction:

```json
{
  "t": "relay_challenge_response",
  "nonce": "<same value>"
}
```

The viewer disables mouse, keyboard, paste, chat, tab switching, and handoff
actions until this exact response decrypts. The host's `HostRelayCodec` also
refuses to release any viewer kind `0x01` or `0x02` message to BetterWright until
it has validated a challenge. Create a new codec for every WebSocket connection;
do not carry challenge state across reconnects.

## Existing BetterWright protocol

After the challenge, the encrypted inner messages are unchanged from the local
live viewer:

- host JSON text: `hello`, `state`, `meta`, `tabs`, `thumb`, `chat`, `toast`,
  and `bye`;
- host binary: JPEG screencast bytes;
- viewer JSON text: `refresh`, `view`, `vis`, `tab`, `input`, `chat`, `answer`,
  `done`, and `cancel`.

The host adapter encrypts each existing text message as kind `0x01` and each
existing binary frame as kind `0x02`. It decrypts viewer kind `0x01` and passes
the resulting UTF-8 string to the existing JSON handler. No JSON is parsed by
the Cloudflare relay.

The host should throttle the screencast before encryption so normal control
messages fit within the relay's sustained token bucket. The relay's byte and
message buckets are a final abuse safeguard, not a video pacing algorithm.

## Relay-to-host plaintext lifecycle notices

The only application text messages emitted by the relay go to the host. They
are never forwarded from a peer and contain no frame, input, chat, URL, root,
capability, or ciphertext data:

```json
{"t":"relay","event":"host_ready","sessionExpiresAtMs":0}
{"t":"relay","event":"viewer_connected","leaseExpiresAtMs":0}
{"t":"relay","event":"viewer_disconnected","code":1000}
{"t":"relay","event":"lease_expiring","leaseExpiresAtMs":0}
{"t":"relay","event":"lease_expired","leaseExpiresAtMs":0}
{"t":"relay","event":"quota_exhausted"}
{"t":"relay","event":"budget_exhausted"}
{"t":"relay","event":"session_expired"}
{"t":"relay","event":"session_closed"}
{"t":"relay","event":"kill_switch"}
```

A host receiving a WebSocket text message must treat it only as relay lifecycle
control. It must never feed that text to the existing BetterWright viewer
protocol. A viewer receiving any plaintext message closes the connection.

## Hibernation and accounting

`RelaySession` accepts sockets with `DurableObjectState.acceptWebSocket()` and
tags them `host` or `viewer`. Attachments persist role, connection time, token
buckets, lease ID, lease expiry, warning state, and whether release was sent.
No relayed payload is placed in an attachment or Durable Object storage.

Viewer time starts when the viewer socket is accepted after admission and ends
at its close event, clamped to the lease expiry. A 15-minute lease never crosses
an ISO-week or billing-window boundary. The viewer reconnects for a new lease;
the root challenge runs again.
