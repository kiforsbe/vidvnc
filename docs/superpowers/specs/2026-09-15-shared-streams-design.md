# Shared capture and encode across sessions

Approved on 2026-09-15. Builds on the multi-session design and the configurable
device limit (Access settings `maxSessions`, default 4). When several devices view
the same display with the same resolved profile, the host captures and encodes once
and sends that encode to every viewer. Desktop audio is shared the same way.

## Server model

The registry separates **sources** from **subscriptions**. A source is one native
worker: one capture and one encode. A subscription is one client's view of a source
and keeps today's per-session `streamId`; every HTTP route remains session-scoped and
stream IDs remain non-credentials.

A video subscription joins an existing source only when all of these match: policy
revision; display id, `x`, `y`, `width`, `height`, `rotation`; resolved profile
`width`, `height`, `fps`, `bitrateKbps`. Profile names do not participate. Audio
sources match on format, `mono-32k` or `stereo-96k`; the server chooses the format
from the session profile (15 fps profiles use mono, as the worker does today).

Host-wide admission counts sources: eight video sources, the aggregate bitrate budget
and the pixel-rate budget. The per-session limit of two video streams counts
subscriptions. Joining a running or starting source costs no encoder budget.

Lifecycle:

- First subscription reserves a source, starts its worker, then adds its peer.
- Later subscriptions add a peer. Peers requested while the source is starting are
  queued until the worker reports `ready`.
- Removing a subscription (client stop, disconnect, host stop-stream) removes only its
  peer. Removing the last subscription stops the worker; its budget releases after OS
  process exit, as today.
- Policy or display revalidation stops invalid sources as a whole.

`NativeMedia` exposes `start(sourceId, plan)`, `addPeer(sourceId, peerId, sdp)`
returning the answer SDP, `removePeer(sourceId, peerId)`, `stop(sourceId)` and
`setPermission(sourceId, peerId, allowed)`. Exit events carry the source id; the
runtime ends every subscription on that source.

## Native worker

Fan-out happens inside one worker process per source.

- Video shared chain: `d3d11screencapturesrc → d3d11convert → nvd3d11h264enc →
  h264parse → tee allow-not-linked=true`.
- Audio shared chain: `wasapisrc loopback → audioconvert → audioresample → opusenc →
  tee allow-not-linked=true`.
- Per-peer video branch: `queue leaky=downstream → rtph264pay pt=<peer payload>
  ssrc=<unique per peer> → caps → webrtcbin`. Audio uses `rtpopuspay`. Each peer owns
  its payloader, SSRC, sequence numbers, ICE, DTLS, NACK/RTX and data channel.

Commands (JSON lines on stdin):

- `start {video, streamPlan, display, audioFormat, hostControl}` builds the shared
  chain and replies `ready` or `fatal`. The pipeline enters PLAYING when the first
  peer is added.
- `add-peer {peerId, sdp}` validates the offer with the existing constrained-baseline
  H.264 / Opus rules, links a new branch to a requested tee pad, syncs its state,
  replies `answer {peerId, sdp}` after ICE gathering completes, then requests a
  keyframe. Join keyframes within 500 ms coalesce into one.
- `remove-peer {peerId}` blocks the tee pad with an idle probe, unlinks and nulls the
  branch, releases the pad, releases held input if that peer had permission, and
  replies `peer-closed {peerId}`.
- `control-permission {peerId, requestId, allowed, leaseMs}` grants or revokes one
  peer. A grant revokes any other peer in the worker. Replies `control-result`.
- `keyframe` and `stop` are unchanged; keyframes stay rate-limited to one per 2 s.

Events: `peer-failed {peerId, reason}` when a peer's ICE or DTLS connection fails;
`metrics` keeps encoder and capture fields at top level and adds
`peers: { [peerId]: transport stats }`.

Connection globals (`peer`, `answered`, `input_channel`, `host_input_permission`)
become a per-peer `Peer` record in a map keyed by id. Pipeline, profile, capture
display and encoder telemetry remain source state. Input from a data channel is
injected only when that channel's peer holds permission. Held keys and buttons stay
worker-wide because they are OS state. Pure logic moves into headers with C++ unit
tests: SDP payload selection, the per-peer permission set, join-keyframe coalescing.

Unchanged: preflight, `--probe`, `--list-displays`, the capture-display watchdog (a
display change is fatal for the whole source) and the 131072-byte stdin command limit.

## Control, recovery and telemetry

The control lease still holds `(sessionId, streamId)`; the runtime resolves it to
`(sourceId, peerId)`. Renewal cadence, lease length, acknowledgement timeout and the
one-pending-change rule are unchanged. `isActive` requires a live subscription and a
running source worker. Transfer between viewers of one source revokes the previous
holder before granting the next; the worker's single-grant rule is a backstop.
Removing a subscription that holds control revokes the lease first.

Each subscription keeps its own `Recovery`, fed by its client telemetry. A tripped
recovery requests a keyframe from the source; the server also limits each source to
one keyframe request per 2 s. A lossy viewer can therefore cause shared keyframes at
most every 2 s; NACK/RTX handles ordinary loss per peer.

Each subscription keeps its own `Diagnostics`. Source `metrics` are split: encoder
and capture fields go to every subscription on the source, `peers[peerId]` transport
fields only to that subscription. Client samples stay per subscription. Status stream
rows and session audio gain `viewers`, the number of subscriptions on the source.

The web client protocol is unchanged: it offers and receives `{streamId, answer}`.

## Failures

- Worker exit (crash or display change): revoke control if held, release every
  subscription on the source; clients observe stream end as today.
- `peer-failed`: end only that subscription.
- Peer negotiation timeout (15 s): remove only that peer; stop the source if it has
  no other subscription.
- Worker failure before `ready`: refuse every queued peer with the worker error.
- Budget refusals (409) occur only when a new source is required; joining can still
  be refused by the per-session limit.

## Host UI and CLI

Sessions stream rows show `Shared · N devices` when a source has more than one
viewer. The Overview summary keeps counting subscriptions as display streams. The CLI
`sessions` table adds a `Shared` column (`×2`; empty when not shared).

## Testing

- Native C++ unit tests: payload selection per peer; permission set (grant revokes
  others, unknown peers rejected); join-keyframe coalescing.
- Server synthetic tests with `tests/fixtures/media-process.mjs` updated to the new
  protocol:
  - stream-registry: matching key (equal joins, any difference creates a source);
    host budgets count sources; per-session limit counts subscriptions; budget
    released only after the last subscription and process exit.
  - stream-runtime: two sessions on the same display and profile start one worker;
    removing one subscription keeps the other live; removing the last stops the
    worker; worker exit ends all subscriptions; `peer-failed` ends one.
  - Control: lease grants and revokes the right peer on a shared source; transfer
    between viewers of one source.
  - Audio: two sessions share one audio worker per format; mono and stereo sessions
    use two.
  - Existing multi-session, CLI and HTTP tests stay green.
- Hardware acceptance (manual, beside `multi-stream-check.mjs`):
  `shared-stream-check.mjs` connects two Playwright loopback viewers to the same
  display and profile, asserts one worker process and decoded frames on both, removes
  one and asserts the other keeps decoding, then adds a third mid-stream and asserts
  it decodes within one second.
- Host navigation fixture includes a shared stream row.

## Out of scope

Per-viewer bitrate adaptation, simulcast or layered encoding, keeping an encoder
alive after its last viewer leaves, and NVENC session limits imposed by other
applications.
