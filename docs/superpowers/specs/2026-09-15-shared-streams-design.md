# Shared capture and encode across sessions

Approved on 2026-09-15. Builds on `2026-09-14-multi-session-design.md` and the
configurable device limit (Access settings `maxSessions`, 1–8, default 4).

## Goal

When several connected devices view the same display with the same resolved stream
profile, the host captures once, encodes once and sends that encode to every viewer.
Desktop audio is shared the same way. Clients see no protocol change.

Why: every video stream today owns an NVENC session. GeForce drivers allow roughly
eight concurrent encoder sessions machine-wide, and the host budgets (eight video
streams, 32 Mbit/s aggregate bitrate, 500 M pixels/s) were sized for independent
encoders. With four devices watching one 4K display, independent encoders exhaust
the pixel-rate budget after the first stream. Shared encoding makes the cost of an
additional viewer network upload only.

## Decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Sequencing | Device limit first (shipped `26eb689`), sharing second | Limit was small and independent |
| Audio | Share audio as well as video | Same fan-out mechanism; removes one loopback capture per session |
| Fan-out location | Inside one native worker per source (approach A) | Lowest latency and process count; reuses the GStreamer stack |
| Tee point | After `h264parse` / `opusenc`, before payloading | Each viewer owns payloader, SSRC and sequence numbers |
| Encoder lifetime | Stops when the last viewer leaves | No idle GPU use; linger deferred |
| Fail-closed control | Remove the peer; stop the whole source only if the worker does not acknowledge | Keeps other viewers unless the worker is untrustworthy |

### Approaches considered

- **A. Fan-out inside the worker (chosen).** One process per source; per-viewer
  `webrtcbin` branches from a `tee`. No inter-process copies. A worker crash drops
  every viewer of that source.
- **B. Encoder process plus per-viewer sender processes.** Encoded access units cross
  a named pipe or shared memory to single-peer senders. Isolates viewer transport
  failures, but keeps one process per viewer, adds framing, backpressure and
  SPS/PPS replay for late joiners, and adds latency. An encoder crash still drops
  every viewer, so isolation gains are small.
- **C. Fan-out in Node.** The worker emits RTP to the server, which terminates WebRTC
  with a JavaScript stack. Adds a dependency, performs DTLS/SRTP on the CPU in JS and
  moves input handling out of the native process that enforces it. Rejected.

## Current architecture (baseline)

- `native/media-worker/src/media-worker.cpp` runs one GStreamer pipeline per process:
  `d3d11screencapturesrc → d3d11convert → nvd3d11h264enc → h264parse → rtph264pay
  (ssrc=10000001) → webrtcbin`, or `wasapisrc loopback → opusenc → rtpopuspay →
  webrtcbin` for audio-only workers. It accepts exactly one `offer`.
- Connection state is global: `peer`, `answered`, `input_channel`, `control`,
  `last_ping`, `pending_input`, the input rate window, `host_input_permission`.
  Held keys and buttons (`held_keys`, `held_buttons`) are OS state.
- Commands on stdin: `offer`, `control-permission`, `keyframe` (worker limit one per
  2 s), `stop`. Output: `answer`, `control-result`, `metrics` each second, `fatal`.
- `apps/server/src/native-media.mjs` maps one stream id to one worker record
  (`child`, `diagnostics`, `recovery`, pending `permission`), with a 15 s negotiation
  timeout and a 3 s kill fallback on stop.
- `apps/server/src/stream-registry.mjs` reserves a slot per stream (per session two,
  host eight, bitrate and pixel budgets); `stream-runtime.mjs` starts one worker per
  reservation and one audio-only worker per session.
- `apps/server/src/control-lease.mjs` grants one `(sessionId, streamId)` owner,
  renewed every 2 s with a 5 s worker lease and a 1.5 s acknowledgement timeout. On
  a failed revoke or grant it stops the worker (fail closed).
- `apps/server/src/recovery.mjs` trips on increasing client PLI/FIR counts, at most
  once per 3 s per stream.

## Server model

### Sources and subscriptions

```
Source        { id, kind: 'video' | 'audio', key, plan, state, subscriptions: Set<streamId>,
                lastKeyframeRequestAt }
Subscription  { id (streamId), sessionId, sourceId, state, recovery, diagnostics }
```

Source states: `starting` → `ready` → `closing` → released after OS process exit.
Subscription states: `negotiating` → `live` → `closing` → released.

### Matching key

Video: `video|<policy revision>|<display id>|<x>,<y>,<width>,<height>,<rotation>|
<width>x<height>@<fps>|<bitrateKbps>`. Profile names and ids do not participate, so
a named profile and a client-options stream with identical values share.

Audio: `audio|mono-32k` or `audio|stereo-96k`. The server derives the format from the
session profile: `fps === 15` selects mono 32 kbit/s, otherwise stereo 96 kbit/s,
matching the worker's current rule. The worker receives the format explicitly and no
longer infers it.

A subscription joins a source in `starting` or `ready`. A source in `closing` is never
joined; a new source with the same key may be reserved immediately if budgets allow,
because a closing source still counts against budgets until its process exits.

### Budgets

- Host-wide, counted over video sources in `starting`, `ready` or `closing`:
  `maxStreams` 8, aggregate `bitrateKbps` 32 000, `pixelsPerSecond` 500 000 000.
  Joining an existing source costs nothing.
- Per session, counted over video subscriptions: `perSession` 2.
- Audio: at most one subscription per session; at most one `starting`/`ready` audio
  source per format.
- `NativeMedia.maxWorkers` becomes 12: eight video sources plus two audio formats,
  each of which may briefly have a closing predecessor.
- Budget refusals remain 409 with the existing messages and occur only when a new
  source is required.

### Registry API

`StreamRegistry` keeps its constructor limits and gains source tracking:

- `subscribe(sessionId, plan)` → `{ stream, source, created }`. Reuses a matching
  `starting`/`ready` source or reserves a new one under the budgets; enforces
  `perSession`.
- `unsubscribe(streamId)` → `{ source, last }`; `last` is true when no subscriptions
  remain, and the source transitions to `closing`.
- `releaseSource(sourceId)` after OS process exit; releases any remaining
  subscriptions.
- `get(sessionId, streamId)`, `list(sessionId?)` and `transition` keep their current
  session-scoped behavior for subscriptions; `source(sourceId)` and
  `sourceOf(streamId)` are new.

### Runtime lifecycle

`offerVideo(sessionId, request)`:

1. Resolve display and profile exactly as today.
2. `registry.subscribe`. On `created`, call `media.start(source.id, plan)`.
3. `media.addPeer(source.id, stream.id, sdp)`; await the answer. The worker queues
   the peer until `ready`.
4. Re-validate session, runtime and policy; transition the subscription to `live`;
   return `{ streamId, type: 'answer', sdp, profile, display }` as today.
5. On failure: `media.removePeer`, `registry.unsubscribe`; if it was the last
   subscription, `media.stop(source.id)`.

`offerAudio(sessionId, sdp)` follows the same steps with the audio key.

`stopStream(sessionId, streamId)`: revoke control if this subscription holds it,
`media.removePeer`, `registry.unsubscribe`; stop the source when `last`.

`stopSession` stops each subscription of the session, including audio.

`revalidate` stops every invalid source; each of its subscriptions is released.

### NativeMedia API

| Method | Behavior |
| --- | --- |
| `start(sourceId, plan)` | Spawn the worker, send `start`, resolve on `ready`, reject on `fatal` or exit. Refuses duplicate ids and `maxWorkers`. |
| `addPeer(sourceId, peerId, sdp)` | Send `add-peer`; resolve with the answer SDP; reject on `peer-failed`, worker exit or a 15 s per-peer timeout (which also sends `remove-peer`). |
| `removePeer(sourceId, peerId)` | Send `remove-peer`; resolve on `peer-closed`, worker exit or 1.5 s timeout; a timeout stops the source. |
| `stop(sourceId)` | Unchanged: `stop`, 3 s kill fallback, resolve after OS exit. |
| `setPermission(sourceId, peerId, allowed)` | As today, addressed to one peer; one pending change per worker. |
| `keyframe(sourceId)` | Send `keyframe` at most once per 2 s per source. |

Worker records gain `peers: Map<peerId, { resolve, reject, timer, state }>` and route
`answer`, `peer-failed` and `peer-closed` by `peerId`. `onExit(sourceId, exit)` fires
once per worker. `metrics` is recorded by the runtime into subscription diagnostics
rather than into a worker-owned `Diagnostics`.

The legacy runtime-less single-stream path (`/api/offer` in `http-app.mjs`) keeps a
compatibility `offer(id, sdp, profile, audio, display)` implemented as `start` plus
`addPeer` with `peerId === id`. That wrapper keeps a worker-owned `Diagnostics` and
`Recovery` so the legacy telemetry route is unchanged. Production always constructs a
`StreamRuntime`, where that route already returns 409.

## Native worker

### Pipelines

Shared video chain (source state):

```
d3d11screencapturesrc name=capture monitor-handle=<handle> show-cursor=true
  ! d3d11convert ! video/x-raw(memory:D3D11Memory),format=NV12,width=W,height=H,framerate=F/1
  ! nvd3d11h264enc name=encoder preset=p3 tune=ultra-low-latency rc-mode=cbr bitrate=B
      gop-size=F bframes=0 zerolatency=true repeat-sequence-header=true
  ! video/x-h264,profile=constrained-baseline,stream-format=byte-stream,alignment=au[,level=3.1]
  ! h264parse ! tee name=fanout allow-not-linked=true
```

Per-peer video branch:

```
queue name=q-<peer> leaky=downstream max-size-buffers=8 max-size-time=200000000 max-size-bytes=0
  ! rtph264pay mtu=1200 config-interval=-1 pt=<peer payload> aggregate-mode=<none|zero-latency>
      ssrc=<peer ssrc>
  ! application/x-rtp,media=video,encoding-name=H264,ssrc=(uint)<peer ssrc>
  ! webrtcbin name=peer-<n> bundle-policy=max-bundle latency=0
```

Shared audio chain: `wasapisrc loopback=true low-latency=true ! audioconvert !
audioresample ! audio/x-raw,format=S16LE,layout=interleaved,rate=48000,channels=<1|2>
! opusenc bitrate=<32000|96000> bitrate-type=cbr frame-size=20 inband-fec=true ! tee
allow-not-linked=true`. Per-peer audio branch: `queue leaky=downstream
max-size-time=100000000 max-size-buffers=5 ! rtpopuspay pt=<peer payload> mtu=1200
ssrc=<peer ssrc> ! webrtcbin`.

SSRCs are allocated per worker as `10000001 + 2 × peer index` for video and
`20000001 + 2 × peer index` for audio, and set on both the payloader and the caps,
preserving the existing workaround for webrtcbin MSID/RTX attribution.

The pipeline enters PLAYING when the first peer branch is linked, so no frames are
captured or encoded without a viewer. Every per-peer webrtcbin keeps `do-nack=TRUE`
on new transceivers.

### Protocol

Commands (stdin JSON lines, ≤ 131 072 bytes each):

| Command | Fields | Result |
| --- | --- | --- |
| `start` | `video: boolean`, `streamPlan {width,height,fps,bitrateKbps,mtu}` (video), `display {id,x,y,width,height,rotation}` (video), `audioFormat: 'mono-32k' \| 'stereo-96k'` (audio), `hostControl: boolean` | `ready`, or `fatal {message}`. A second `start` is fatal. |
| `add-peer` | `peerId: string (1–64 chars)`, `sdp: string (≤ 65 536)` | `answer {peerId, sdp}` after ICE gathering completes, or `peer-failed {peerId, reason}`. Duplicate ids and add before `start` fail the peer. Peers received before `ready` are queued. |
| `remove-peer` | `peerId` | `peer-closed {peerId}`; unknown ids also reply `peer-closed`. |
| `control-permission` | `peerId`, `requestId`, `allowed`, `leaseMs (1–5000)` | `control-result {requestId, allowed}`; invalid fields remain fatal. |
| `keyframe` | – | Force-key-unit on the encoder, at most once per 2 s. |
| `stop` | – | Shutdown as today. |

Events: `ready`; `answer`; `peer-failed {peerId, reason}` on SDP rejection, answer
failure, or webrtcbin `connection-state` `failed`; `peer-closed`; `control-result`;
`fatal`; `metrics` each second while any peer exists:

```
{ type: 'metrics', <existing MediaTelemetry fields>, forceKeyUnitEvents, encodedKeyframes,
  spsProfile, spsLevel, peers: { [peerId]: <existing TransportTelemetry fields> } }
```

Audio workers report audio telemetry at top level and per-peer transport in `peers`.

### Per-peer state

```
struct Peer {
  std::string id; unsigned index;
  GstElement *branch; GstElement *webrtc; GstPad *tee_pad;
  bool answered; GstWebRTCDataChannel *input_channel;
  bool control; gint64 last_ping; gint64 rate_window; int rate_count;
  std::atomic<int> pending_input;
};
```

Source state keeps pipeline, profile, capture display, encoder and audio telemetry,
`HostInputPermission` plus the permitted peer id, held keys/buttons and the recovery
timestamps.

Input rules:

- A data channel labeled `input` is attached to its peer; other labels and all
  channels on audio workers are closed.
- Messages are processed only for the peer that owns the channel. Injection requires
  `peer.control` and, when `hostControl` is required, that the peer is the permitted
  peer with a live lease.
- Granting a peer revokes any other peer in the worker and releases held input first.
- Revoke, peer removal, channel close, lost ping (5 s) or lease expiry for the permitted
  peer releases held input and sends `{"control":false}` on that peer's channel.
- The 1000 messages per second limit and the 256 pending-message cap apply per peer.

### Adding and removing peers

Add: parse and validate SDP (H.264 constrained baseline with packetization mode 1 for
video; Opus for audio), build the branch with the peer's payload type and SSRC, add to
the pipeline, request a tee src pad, link, `gst_element_sync_state_with_parent`, set
the remote description, create and set the answer, wait for ICE gathering, emit
`answer`, then request a join keyframe. Join keyframe requests within 500 ms coalesce;
they are independent of the 2 s recovery limit.

Remove: add an idle probe on the tee src pad; in the probe, unlink, set the branch to
NULL, remove it from the pipeline, release the tee pad; release input if the peer was
permitted; emit `peer-closed`. Removing the last peer leaves the pipeline running
until the server's `stop`.

All pipeline mutation runs on the GLib main loop.

Unchanged: `--probe`, `--list-displays`, `--self-test`, preflight element checks, the
1 s capture-display watchdog (a display change is fatal for the whole source).

## Control

- The lease keeps `(sessionId, streamId)`. The runtime resolves `sourceOf(streamId)`
  and calls `media.setPermission(sourceId, streamId, allowed)`.
- Renew every 2 s, 5 s worker lease, 1.5 s acknowledgement timeout, one pending change
  per worker: unchanged.
- `isActive(sessionId, streamId)` requires a `live` subscription whose source is
  `ready` with a running worker.
- Transfer between two viewers of the same source revokes the previous peer before
  granting the next; the worker's single-grant rule is a backstop.
- Fail closed: if a revoke or grant is not acknowledged, the lease calls
  `media.removePeer(sourceId, peerId)`; if removal is not acknowledged within 1.5 s,
  it stops the whole source. A worker that fails to acknowledge is not trusted to keep
  input disabled for any peer.

## Recovery

- Each subscription keeps its own `Recovery` (PLI/FIR increase, 3 s per subscription).
- A trip calls `media.keyframe(sourceId)`, limited to one request per 2 s per source
  on the server and in the worker.
- Join keyframes are separate and coalesce within 500 ms.
- Consequence: one viewer with sustained decoder loss causes a shared keyframe at most
  every 2 s. NACK/RTX in each peer's webrtcbin handles ordinary packet loss. A leaky
  queue drop on one peer only affects that peer, which then requests recovery.

## Telemetry and diagnostics

- Each subscription owns a `Diagnostics` started with its plan.
- Source `metrics` are split: top-level encoder, capture and audio fields are recorded
  into every subscription of the source; `peers[peerId]` fields are recorded only into
  that subscription.
- Client samples (`/api/stream-telemetry`, `/api/audio-telemetry`) are recorded per
  subscription as today.
- `runtime.status()` stream rows and session audio gain `viewers`: the number of
  subscriptions on the source.
- `/diagnostics` stream selection remains per subscription.

## Failures

| Event | Effect |
| --- | --- |
| Worker exit (crash, fatal, display change) | Revoke control if held on the source; release every subscription; release budget after OS exit. Clients observe the stream missing from `/api/heartbeat` and the WebRTC connection closing, as today. |
| `peer-failed` | End only that subscription. |
| Peer negotiation timeout (15 s) | `remove-peer`; end that subscription; stop the source if it was the last. |
| Worker fails before `ready` | Reject every queued peer with the worker error. |
| `remove-peer` not acknowledged (1.5 s) | Stop the source. |
| Policy busy or revision change | As today: 409 on new offers; invalid sources stopped. |
| Budget exhausted | 409 only when a new source is required. |

## Host UI and CLI

- Sessions page stream rows show `Shared · N devices` when `viewers > 1`.
- Overview summary continues to count subscriptions as display streams.
- CLI `sessions` table adds a `Shared` column (`×2`; empty when not shared).
- No new settings; CLI parity is unaffected.

## Touch points

- Native: `media-worker.cpp` (source/peer split, protocol), new headers for payload
  selection, peer permission and keyframe coalescing, `CMakeLists.txt` test targets.
- Server: `stream-registry.mjs`, `stream-runtime.mjs`, `native-media.mjs`,
  `control-lease.mjs`, `http-app.mjs` (legacy path uses the compatibility `offer`),
  `host-status.mjs` (`viewers`), `main.mjs` (`maxWorkers` 12), CLI `sessions` format.
- Host: `HostWindow.Sessions.cs` (shared label), navigation fixture.
- Tests: `tests/fixtures/media-process.mjs` (new protocol), registry, runtime, control,
  multi-session, HTTP and CLI tests; native C++ unit tests; hardware check.
- Web client: none.

## Risks to verify first

1. Upstream force-key-unit events from a peer branch reach `nvd3d11h264enc` through
   `tee` and `h264parse`; otherwise the worker sends the event to the encoder directly.
2. Adding a `webrtcbin` to a PLAYING pipeline negotiates and produces decodable video
   for a late joiner, with SPS/PPS inserted by `config-interval=-1` before the forced
   IDR.
3. Per-peer SSRC on payloader and caps keeps MSID attribution correct for every peer.
4. Removing a branch through an idle tee pad probe does not stall other branches.
5. A leaky per-peer queue isolates a slow peer without stalling the encoder.

A throwaway native spike covering 1–4 with two loopback viewers precedes the worker
refactor.

## Testing

- Native C++ unit tests: SDP payload selection per peer; peer permission set (grant
  revokes others, unknown peer rejected, lease expiry); join-keyframe coalescing
  within 500 ms.
- Server synthetic tests (`media-process.mjs` implements `start`, `add-peer`,
  `remove-peer`, `peer-failed` injection, `control-permission`, `keyframe`):
  - Registry: equal keys share; each differing key field creates a new source;
    host budgets count sources; per-session limit counts subscriptions; a `closing`
    source is not joined; budget releases only after last unsubscribe and exit.
  - Runtime: two sessions, same display and profile → one worker; stop one → other
    stays live; stop last → worker stopped; worker exit → all subscriptions
    released; `peer-failed` → one released; negotiation timeout → peer removed.
  - Control: grant and revoke address the right peer; transfer between viewers of one
    source; unacknowledged revoke removes the peer; unacknowledged removal stops the
    source.
  - Recovery: two tripping subscriptions produce one keyframe per 2 s.
  - Audio: two sessions share one audio worker; mono and stereo sessions use two.
  - Existing multi-session, HTTP security, CLI and approved-client tests stay green.
- Hardware acceptance (manual, beside `multi-stream-check.mjs`):
  `shared-stream-check.mjs` with two Playwright loopback viewers on one display and
  profile asserts one worker process and decoded frames on both; removes one and
  asserts continued decoding on the other; adds a third mid-stream and asserts first
  decoded frame within 1 s; grants control to one viewer and asserts the other's input
  channel reports `control:false`.
- Host navigation fixture includes a shared stream row.

## Out of scope

Per-viewer bitrate adaptation, simulcast or layered encoding, keeping an encoder alive
after its last viewer leaves, sharing encodes between different profiles, and NVENC
session limits consumed by other applications.
