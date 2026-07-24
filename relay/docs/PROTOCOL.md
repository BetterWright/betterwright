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

Decode the root to 32 bytes. Each sender generates a fresh random 16-byte
`senderEpoch` when its WebSocket connection is created. Compute:

```text
salt = SHA-256(
  UTF8("BetterWright relay HKDF salt v1" || NUL || sessionId || NUL) ||
  senderEpoch
)
```

Use HKDF-SHA-256 with that salt and one of these exact info strings to derive a
256-bit AES-GCM key:

```text
BetterWright relay host-to-viewer AES-GCM v1
BetterWright relay viewer-to-host AES-GCM v1
```

Keys are directional and epoch-specific. Decrypting with the opposite key,
direction, session, or epoch must fail.

## Binary envelope

Every peer message is a binary WebSocket message. Integer sequences are
unsigned, big-endian, begin at zero, and increase by exactly one per sender:

```text
Offset  Length  Meaning
0       1       version = 0x01
1       1       direction: 0x01 host-to-viewer, 0x02 viewer-to-host
2       16      senderEpoch
18      8       sequence
26      rest    AES-GCM ciphertext and 16-byte tag
```

The 12-byte AES-GCM nonce is derived, not transmitted separately:

```text
byte 0      0x01 (version)
byte 1      direction byte
bytes 2-3   0x00 0x00
bytes 4-11  sequence, unsigned big-endian
```

The authenticated additional data is the complete 26-byte header followed by:

```text
UTF8("BetterWright relay envelope v1" || NUL || sessionId || NUL || direction)
```

where direction is exactly `h2v` or `v2h`.

The decrypted AES-GCM plaintext begins with one protected kind byte followed by
the existing protocol bytes:

```text
0x00  BetterWright JSON text message, UTF-8
0x01  BetterWright binary payload, currently a JPEG screencast frame
0x02  relay root-key challenge JSON, UTF-8
```

The kind is encrypted. The relay does not inspect it and therefore cannot tell
a frame from input, chat, or protocol control. It forwards the complete envelope
unchanged. A receiver latches the first authenticated sender epoch, rejects a
changed epoch until reconnect, and rejects every non-increasing sequence as a
replay. Sequence exhaustion is terminal; reconnecting creates a fresh epoch and
new keys.

The complete envelope, including the 26-byte header, protected kind,
ciphertext, and tag, must not exceed 2 MiB under the reviewed default.

## Root-key challenge

After the relay announces `viewer_connected`, the host generates 32 random
bytes as a 43-character unpadded-base64url challenge and sends encrypted kind
`0x02` in the host-to-viewer direction:

```json
{
  "t": "bw_e2e_challenge",
  "challenge": "<43-character-base64url>"
}
```

The viewer decrypts it and echoes the exact value in encrypted kind `0x02` in
the viewer-to-host direction:

```json
{
  "t": "bw_e2e_ready",
  "challenge": "<same value>"
}
```

The viewer disables mouse, keyboard, paste, chat, tab switching, and handoff
actions until it has successfully decrypted the host challenge and sent the
echo. The host refuses to release any viewer text or binary message to
BetterWright until that echo decrypts and matches in constant time. Create fresh
senders, receivers, epochs, and challenge state for every viewer connection; do
not carry them across reconnects.

## Existing BetterWright protocol

After the challenge, the encrypted inner messages are unchanged from the local
live viewer:

- host JSON text: `hello`, `state`, `meta`, `tabs`, `thumb`, `chat`, `toast`,
  and `bye`;
- host binary: JPEG screencast bytes;
- viewer JSON text: `refresh`, `view`, `vis`, `tab`, `input`, `chat`, `answer`,
  `done`, and `cancel`.

The host adapter encrypts each existing text message as kind `0x00` and each
existing binary frame as kind `0x01`. It decrypts viewer kind `0x00` and passes
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

Explicit termination first closes peers and settles any viewer lease, then
removes the session's Durable Object storage and D1 row. At absolute expiry the
Durable Object performs the same peer/lease close, deletes its D1 row, and calls
`deleteAll()`; a transient D1 failure keeps only the minimal session config and
re-arms cleanup instead of orphaning permanent state.
