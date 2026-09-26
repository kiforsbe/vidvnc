# Architecture

VidVNC streams a Windows desktop to a browser over WebRTC on the local network:
DXGI desktop duplication into a hardware video encoder, out as RTP, with keyboard and
mouse travelling back. This document describes how the running system is put together
and the conventions the repository follows.

See [distribution requirements](PACKAGING.md) for the six self-contained products:
server/host, native viewer, and CLI server, each on Windows and macOS. Build modules
are reusable inputs to those products, not one duplicated source tree per installer.

## System overview

Three processes, each in the language that suits its job. The split is deliberate:
Windows capture and GStreamer need C++, session and authentication logic is far easier
to write and test in JavaScript, and the desktop UI belongs in WinUI.

```mermaid
flowchart LR
    subgraph client["Client device"]
        browser["Browser<br/>apps/web-client"]
    end

    subgraph machine["Windows host machine"]
        host["WinUI 3 host<br/>apps/windows-host"]
        server["Node server<br/>apps/server"]
        worker["media-worker (C++)<br/>native/media-worker"]
        gst["GStreamer 1.28"]
        win["DXGI · WASAPI · SendInput"]
    end

    browser <-->|"HTTPS by default: auth, SDP offer/answer,<br/>telemetry; deliberate LAN HTTP off mode"| server
    browser <-.->|"WebRTC: RTP video + audio,<br/>data channel for input"| worker
    host -->|"spawns in a job object;<br/>JSON lines on stdin/stdout"| server
    server -->|"one child per source;<br/>JSON lines on stdin/stdout"| worker
    worker --> gst --> win
```

The browser talks to the Node server for everything except media, and to the worker for
media only. The server never carries pixels; the worker never authenticates anyone.

Signaling is HTTP request/response over HTTPS by default, not WebSocket. The browser POSTs an offer and
receives the answer in the same response, after ICE gathering completes. There is no
STUN or TURN server and no trickle ICE: on the LAN, host-local candidates are all there
are. With remote access on, an internet client's answer instead names the router's public
address on a fixed, forwarded media port range, and its offer keeps only public-address
candidates ([sdp-candidates.mjs](../apps/server/src/sdp-candidates.mjs)). A relay or
rendezvous hub is future work.

## Process lifetime and ownership

The WinUI host owns the server, and the server owns its workers. Both links fail closed.

- The host creates a Win32 job object with `KILL_ON_JOB_CLOSE` and assigns the Node
  process to it, so the server cannot outlive the host even if the host is killed. The
  handle is non-inheritable and belongs only to the host ([ServerJob.cs](../apps/windows-host/ServerJob.cs)).
- The server does not open its port until the desktop owner approves. It reads one line
  from stdin and accepts only the exact bytes `{"type":"start"}`; anything else, an
  over-long line, or a closed stream aborts startup
  ([owner-start.mjs](../apps/server/src/owner-start.mjs)). A server launched by something
  other than its host therefore never begins listening.
- After startup the same stdio channel carries host commands in and `status` events out,
  which is what the host UI renders.
- The CLI server is the same Node application driven from a terminal instead of the
  WinUI host.

## Sessions, streams and sources

Three levels, and the distinction between the last two is the part worth understanding.

```mermaid
classDiagram
    class Session {
        +string sessionId
        +string token
        +profile
        +heartbeat deadline
    }
    class Stream {
        +string id
        +string sourceId
        +display or audio
        +subscription state
    }
    class Source {
        +string id
        +string sourceKey
        +worker process
        +encoder
    }
    class ControlLease {
        +owner
        +grant()
        +release()
    }
    Session "1" --> "*" Stream : subscribes
    Stream "*" --> "1" Source : shares
    Session "0..1" --> "1" ControlLease : may hold
```

A **session** is one authenticated client. A **stream** is one client's subscription to
one display or to audio. A **source** is one running worker process producing one encode.

Streams share a source when their encode would be byte-identical. `sourceKey` is built
from exactly the fields that change captured or encoded bytes — display geometry,
resolution, frame rate, bitrate, bitrate mode, codec, and quality only when VBR makes it
matter — and from nothing else ([stream-registry.mjs](../apps/server/src/stream-registry.mjs)).
Profile names and ids are deliberately excluded, so two differently named but numerically
identical profiles encode once and fan out to both viewers rather than running two
encoders. Audio keys on its format alone.

Input is governed by a **control lease** held by at most one session. The lease is a
host-only coordinator: a client request never grants control to itself, and the grant is
serialized so overlapping requests cannot interleave
([control-lease.mjs](../apps/server/src/control-lease.mjs)).

## Control plane

All client traffic is HTTP under `/api`, plus the static client assets. Routes fall into
four groups:

| Group       | Routes                                                                                                          | Purpose                                                                                 |
| ----------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Admission   | `/api/key-start`, `/api/approved-clients/*`                                                                     | Meter key attempts or authenticate an approved browser/client and issue a session token |
| Negotiation | `/api/offer`, `/api/stream-offer`, `/api/audio-offer`, `/api/streams`, `/api/stream-select`, `/api/stream-stop` | Start, pick and tear down media                                                         |
| Liveness    | `/api/heartbeat`, `/api/reconnect`, `/api/disconnect`                                                           | Keep, recover or end a session                                                          |
| Reporting   | `/api/telemetry`, `/api/stream-telemetry`, `/api/audio-telemetry`, `/api/profiles`, `/api/info`                 | Client-side metrics and public-safe status on the normal listener                       |

Three connection modes are supported, set by the host
([access-settings.mjs](../apps/server/src/access-settings.mjs)):

- `session-key` — one shared key admits clients for the session.
- `one-time-keys` — each key is consumed by the client that redeems it.
- `approved-only` — only clients previously registered and approved by the host.

Stream policy — which profiles exist, which codecs are allowed, which encoder backend to
use — is host-owned, versioned by a revision number, and validated as a whole before it
is stored. Clients may choose among what the policy allows and, when the host enables it,
supply custom settings that are checked against approved bounds; they can never widen the
policy itself.

## Media pipeline

One capture and one encode per source, then a per-viewer branch off a tee. Adding a
second viewer to an identical plan costs a payloader and a `webrtcbin`, not another
encoder.

```mermaid
flowchart LR
    cap["d3d11screencapturesrc<br/>monitor-handle, show-cursor"] --> conv["d3d11convert<br/>NV12, profile size and fps"]
    conv --> enc["hardware encoder<br/>(selected per machine)"]
    enc --> caps["codec caps"] --> parse["h264parse / h265parse / av1parse"]
    parse --> vtee["tee video-fanout"]

    wasapi["wasapisrc loopback"] --> ares["audioconvert · audioresample<br/>48 kHz S16LE"] --> opus["opusenc<br/>32k mono / 96k stereo, FEC"] --> atee["tee audio-fanout"]

    vtee --> vq["queue leaky=downstream"] --> vpay["rtph264pay / rtph265pay / rtpav1pay"] --> wrtc["webrtcbin<br/>max-bundle"]
    atee --> aq["queue leaky=downstream"] --> apay["rtpopuspay"] --> wrtc
    wrtc --> peer(["browser peer"])
```

Frames stay in D3D11 memory from capture through encode; there is no download to system
memory. Both per-peer queues are `leaky=downstream`, so a viewer whose network stalls
drops its own frames instead of stalling the shared encoder — the failure stays local to
that viewer. Audio follows the session profile rather than being chosen separately: the
15 fps mobile profiles get the low-bandwidth mono mix.

Rate control is expressed as intent — mode, target and peak bitrate, GOP length, and
quality floors as _fractions_ of the element's QP range — and only turned into concrete
property strings at pipeline build time. See the next section for why.

## Hardware encoder selection

Four encoder families are supported: NVENC, Intel Quick Sync, AMD AMF and Media
Foundation. Which one runs is decided per machine at stream start, not at build time.

### Model

`video-codec.hpp` and `encoder-backend.hpp` are two tables that are joined, not one
table with two concerns. A codec row is true of the bitstream on any chip; a backend
row is true of one vendor's elements. `encoder-selection.hpp` is pure and therefore
testable without a GPU, and `encoder-properties.hpp` is the only place that turns
intent into a property string.

```mermaid
classDiagram
    class VideoCodec {
        +string id
        +string label
        +string caps
        +string parser
        +string payloader
        +string encoding_name
        +string rtpmap
    }
    class EncoderBackend {
        +string id
        +string label
    }
    class EncoderDialect {
        +string rc_mode_property
        +string cbr_value
        +string vbr_value
        +string bitrate_property
        +string max_bitrate_property
        +string gop_property
        +string bframes_property
        +vector~string~ qp_floor_i_properties
        +vector~string~ qp_floor_p_properties
        +string header_repeat_property
    }
    class CodecSupport {
        +string codec_id
        +string element
    }
    class Dimensions {
        +int width
        +int height
    }
    class PropertyValue {
        +string property
        +string value
    }
    class RateControl {
        +RateMode mode
        +int bitrate_kbps
        +int max_bitrate_kbps
        +int gop_frames
        +double qp_floor_i
        +double qp_floor_p
    }
    class EncoderProperties {
        +string text
        +vector~string~ skipped
    }
    class EncoderCandidate {
        +string backend_id
        +string element_name
        +bool has_adapter
        +int64 adapter_luid
    }
    class Selection {
        +bool found
        +SelectionReason reason
    }
    class SelectionReason {
        <<enumeration>>
        AdapterMatch
        FixedOrder
        Forced
        ForcedUnavailable
    }

    EncoderBackend *-- EncoderDialect : dialect
    EncoderBackend *-- "0..3" CodecSupport : codecs
    CodecSupport *-- Dimensions : minimum
    EncoderDialect *-- "*" PropertyValue : low_latency
    Selection *-- EncoderCandidate : candidate
    Selection --> SelectionReason
    EncoderCandidate ..> EncoderBackend : backend_id
    CodecSupport ..> VideoCodec : codec_id
    EncoderProperties ..> EncoderBackend : built from dialect
    EncoderProperties ..> RateControl : built from intent
```

`qp_floor_*_properties` are lists, not names, because AMF disagrees with itself:
`amfh264enc` declares a single `min-qp`, `amfh265enc` declares `min-qp-i`/`min-qp-p`,
and `amfav1enc` declares neither. The floors in `RateControl` are fractions of the
element's QP range rather than QP numbers, because the families do not share a scale
and the Quick Sync and AMF AV1 ranges are undocumented; the real range is read from
the element and the fraction scaled onto it.

### Selection rule

Affinity beats vendor preference. DXGI desktop duplication captures on whichever GPU
drives the monitor — on a hybrid laptop usually the integrated one — so an encoder on
that same adapter avoids copying every frame across adapters. The table order in
`encoder_backends()` only breaks ties.

```mermaid
flowchart TD
    begin([select_encoder]) --> forced{"host set<br/>encoderBackend?"}
    forced -->|yes, and installed| useForced["reason = Forced"]
    forced -->|no, or not installed| rank["rank each candidate:<br/>0 = on capture adapter<br/>1 = on another adapter<br/>2 = declares no adapter-luid"]
    rank --> best["lowest rank wins;<br/>ties broken by table order<br/>nvenc, qsv, amf, mediafoundation"]
    best --> any{"any candidate?"}
    any -->|no| none["found = false"]
    any -->|yes| wasForced{"was a backend<br/>forced?"}
    wasForced -->|yes| unavailable["reason = ForcedUnavailable"]
    wasForced -->|no| matched{"rank 0?"}
    matched -->|yes| adapter["reason = AdapterMatch"]
    matched -->|no| order["reason = FixedOrder"]
```

A forced backend that is not installed does not refuse the stream. A configuration
file follows its machine, and the hardware it names may simply not be there;
`ForcedUnavailable` records that the automatic pick was used instead.

### Start-up flow

```mermaid
sequenceDiagram
    participant Host as WinUI host / CLI
    participant Server as Node server
    participant Worker as media-worker (C++)
    participant GStreamer

    Server->>Worker: probe
    Worker->>GStreamer: for each family, load factory and<br/>encode 10 real D3D11 frames
    GStreamer-->>Worker: works / fails
    Worker->>GStreamer: DXGI EnumAdapters1 + EnumOutputs,<br/>element adapter-luid
    Worker-->>Server: { codecs, backends[{id,label,onCaptureAdapter,codecs,minimums}] }
    Server-->>Host: status.encoders { available, setting }

    Host->>Server: set policy.encoderBackend (auto, nvenc, qsv, amf, mediafoundation)
    Note over Server: selectVideoCodec narrows to the forced<br/>backend's codecs when one is set

    Server->>Worker: start { videoCodec, encoderBackend, ... }
    Worker->>Worker: select_encoder(candidates, capture luid, forced)
    Worker->>GStreamer: g_object_class_find_property per wanted property
    GStreamer-->>Worker: declared / absent (+ QP range)
    Worker->>GStreamer: gst_parse_launch with surviving properties only
    Worker-->>Server: ready { encoderBackend, encoderLabel, encoder, encoderReason }
    Server-->>Host: status.sessions[].streams[].encoder
```

The probe's `codecs` keeps its original meaning — what this machine can encode with
any family — so older readers of that field are unaffected. `backends` is the new
detail. A worker built before backends existed reports no `backends` key and the
server defaults it to an empty list.

### Contract fields

| Message      | Field                                    | Meaning                                                          |
| ------------ | ---------------------------------------- | ---------------------------------------------------------------- |
| probe result | `backends[].id`                          | `nvenc`, `qsv`, `amf`, `mediafoundation`                         |
| probe result | `backends[].onCaptureAdapter`            | Element sits on the GPU that captures                            |
| probe result | `backends[].minimums[codec]`             | Smallest input the element accepts                               |
| `start`      | `encoderBackend`                         | Host override, or absent for automatic                           |
| `ready`      | `encoderBackend`, `encoderLabel`         | What was actually chosen                                         |
| `ready`      | `encoder`                                | The GStreamer element name                                       |
| `ready`      | `encoderReason`                          | `capture-adapter`, `forced`, `forced-unavailable`, `fixed-order` |
| `status`     | `encoders.available`, `encoders.setting` | Host-facing only; no client sees these                           |

There is no software encoder fallback. If no family delivers H.264 the worker fails
the probe by name, listing every element it tried.

## Input and control

Keyboard and mouse do **not** travel over HTTP. The browser opens a WebRTC data channel
to the worker and sends `move`, `key`, `button` and `wheel` messages on it, which the
worker turns into `SendInput` calls. Input therefore takes the same path as the video and
inherits its latency, rather than queueing behind the signaling server.

Because that channel bypasses the server, the worker enforces permission itself and
trusts nothing on the channel:

- Only the owner pipe — the server, over stdin — can change who may send input
  (`control-permission`). A client can ask to _use_ control it has already been granted;
  it can never grant itself any ([peer-permission.hpp](../native/media-worker/src/peer-permission.hpp)).
- An unknown peer id means the server's view is stale, so the worker refuses it and
  clears the current owner rather than guessing.
- Coordinates are normalised 0..1 and rejected unless finite and in range; button and key
  codes are mapped through explicit allow-lists, never passed through
  ([input-policy.hpp](../native/media-worker/src/input-policy.hpp)).
- If the capture display changes underneath a session, the worker releases any held keys
  and buttons and fails the session rather than replaying input against different
  geometry.

Granting control to a second peer revokes it from the first; only one peer holds it.

Touch gestures are interpreted in the browser
([viewer/app.js](../apps/web-client/src/viewer/app.js)); the worker only ever sees the
same `move` and `button` messages a mouse produces. A touch does not press a button when
it lands, because a finger that drags to move the pointer would otherwise click when it
lifts. Instead:

| Gesture                                                            | Messages sent                                         |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| Drag                                                               | `move` only                                           |
| Tap (lifted within 10 px of where it landed, before the hold time) | left `button` down then up on lift                    |
| Tap, then touch again within 350 ms and 40 px, and drag            | left `button` down at once, `move`, up on lift        |
| Touch and hold still for 450 ms, then drag                         | left `button` down after the hold, `move`, up on lift |

Only the first finger is tracked; a second concurrent touch is ignored. A cancelled
touch releases control like any other `pointercancel`. Mouse and pen input still press
and release buttons exactly as the device reports them.

## Resilience

Recovery is driven by what the browser reports, and is deliberately damped.

The client reports cumulative `pliCount` and `firCount`. The server treats an increase as
a request for a keyframe, but ignores the first sample and counter resets — neither means
loss — and rate-limits what it forwards ([recovery.mjs](../apps/server/src/recovery.mjs)).
The worker limits again at the source: join keyframes may coalesce over a short window,
while recovery keyframes keep a source-wide two-second floor
([keyframe-limiter.hpp](../native/media-worker/src/keyframe-limiter.hpp)). Both limits
exist because a keyframe is the most expensive frame there is, and sustained packet loss
across several viewers would otherwise produce an IDR storm that worsens the loss.

Sessions are kept by heartbeat and can be resumed through `/api/reconnect` while a
session is in a reconnecting state; ordinary API calls are rejected meanwhile so a
half-recovered client cannot act on stale state.

## Diagnostics

The server keeps a diagnostics snapshot per worker — selected encoder, stream state,
transport and client-reported metrics — exposed at `/api/diagnostics` only on a
separate `127.0.0.1`-bound listener. The normal HTTP/HTTPS handler does not route
the diagnostics API, page, or dedicated assets. The host and CLI issue an explicit,
short-lived local URL and bearer; the browser page sends that bearer only in an
Authorization header. Encoder facts land there at `ready` and then hold,
because the worker chooses its encoder once per stream and never switches mid-stream.

Which GPU is encoding is host-facing only. It appears in host status and diagnostics, and
no client ever sees it.

## Trust boundaries

Stated plainly, because the scope limit is a design decision rather than an oversight:

- **The control plane serves HTTPS by default**
  ([http-app.mjs](../apps/server/src/http-app.mjs)). On first run VidVNC provisions its
  own certificate automatically, trying an operator-supplied certificate first, then
  mkcert's local CA, then a self-signed certificate issued through Windows — see [TLS and
  trust provisioning](#tls-and-trust-provisioning) below for the exact order and why. A
  local-only HTTP listeners stay up alongside the TLS one to serve the enrolment page and
  redirect everything else to HTTPS while TLS is live. If HTTPS is pending or fails,
  viewer/auth/session/signaling requests receive no-store `503`, not a plaintext fallback.
  The one case where the old description — plain HTTP, no TLS, nothing readable-in-transit protection —
  still holds exactly is **`off` mode**, an explicit opt-out that restores today's
  LAN-only HTTP viewer behaviour with no redirect. Exposing a port to an untrusted network
  is supported only through remote access (next point).
- **Internet clients are decided by the socket's source address, never a header**
  ([peer-network.mjs](../apps/server/src/peer-network.mjs)). With remote access off (the
  default) they are refused. With it on, which requires `approved-only` mode, they get
  HTTPS only and approved-device sign-in only, with their own admission budget
  ([admission-budget.mjs](../apps/server/src/admission-budget.mjs)). The operator's steps
  and the open findings are in [remote access](security/remote-access.md) and the
  [security analysis](security/internet-exposure.md).
- **The viewer is served only after admission.** Its markup, script and styles under
  `/viewer/` need a session-bound cookie that revocation invalidates; the API still needs
  the bearer token. The login page imports the viewer into the live document, not by
  adopting nodes from a template: WebKit sets a media element's inline-playback policy when
  the element is created.
- **The media plane is encrypted regardless**, since WebRTC mandates DTLS-SRTP. Pixels
  and audio are not in the clear; signaling uses HTTPS by default or deliberate LAN HTTP.
- **Approved-client credentials are stored hashed**, with a per-client salt, scrypt, and
  constant-time comparison ([approved-clients.mjs](../apps/server/src/approved-clients.mjs)).
  Tokens and claim values are 32 random bytes.
- **The desktop owner is the root of trust.** The server does not listen until the local
  host approves, and the host outlives nothing it started.
- **The worker trusts only its owner pipe.** Everything arriving from a peer — SDP, data
  channel input, telemetry — is validated before use.

Pairing and passkeys are future work; see [ROADMAP.md](ROADMAP.md).

## TLS and trust provisioning

### Two listeners

The plaintext listener keeps the product's original port, `4382` by default
(`VIDVNC_PORT`-overridable, [main.mjs](../apps/server/src/main.mjs)). The TLS listener
takes a second port, `4383` by default — one above the plaintext default so the pair
never collides out of the box — independently configurable through TLS settings or the
CLI's `tls-port` command
([tls-settings.mjs](../apps/server/src/tls/tls-settings.mjs)). If the two ever end up
equal (for example `VIDVNC_PORT` moved onto the TLS default), TLS is disabled for that
run rather than failing to start, and the reason is logged; HTTP viewer access remains disabled
([load-settings.mjs](../apps/server/src/tls/load-settings.mjs)).

The HTTP listeners bind only loopback and eligible physical Private-LAN addresses, never a
wildcard or public address. `VIDVNC_HOST` can narrow those binds but cannot widen them;
adapter refresh removes ineligible sockets. The handler also checks the live peer scope on
every HTTP request, including existing keep-alive connections. The local scope is injected
into the production router as well as the listener manager. Trust routes are local-peer-only
on HTTP **and HTTPS**, even when TLS binds publicly.

Once TLS is active, local HTTP serves only the enrolment page and its assets
(`/trust` and everything it loads) plus the two trust API routes
(`/api/trust/anchor`, `/api/trust/status`) unredirected. Diagnostics routes return `404`
on both main ports; other plaintext requests get a `307` redirect (not `308`, so a client that cached it does not keep being sent to
a TLS port that may later change) to the same path and query on the HTTPS listener,
preserving the request method. Absolute-form requests must match the socket scheme,
authority, and port before routing; they cannot bypass the redirect. When HTTPS is
required but unavailable, every non-trust HTTP route returns no-store `503`. Only a
valid, deliberate `tls.mode: off` serves the full viewer over LAN-only HTTP. A device
that does not yet trust the host has no un-warned way to fetch the trust anchor over the very connection that anchor
exists to authenticate, so those routes remain reachable locally in the clear
([http-app.mjs](../apps/server/src/http-app.mjs)).

### Strategy order and reissue

Provisioning tries strategies in a fixed order — `provided`, then `mkcert`, then
`windows-self-signed` — and uses the first one that is available and succeeds
([ensure-certificate.mjs](../apps/server/src/tls/ensure-certificate.mjs),
`DEFAULT_STRATEGIES`). In `provided` mode only the `provided` strategy is ever a
candidate, so a failure there is reported rather than silently replaced by a generated
certificate. In every other mode all three are tried in that order:

| Strategy              | Condition                                          | Anchor a device must trust         |
| --------------------- | -------------------------------------------------- | ---------------------------------- |
| `provided`            | Operator configured a certificate and key (or PFX) | Whatever their CA chain already is |
| `mkcert`              | `mkcert` resolves on `PATH`                        | The mkcert local root CA           |
| `windows-self-signed` | Always available on Windows                        | The leaf certificate itself        |

A credential is reissued — at startup, and again on a periodic re-check — whenever any
of these holds: it is absent or unreadable; its expiry falls inside the renewal window
(30 days by default); or its subject alternative name no longer covers an address the
machine currently has, which is what keeps a certificate valid across a DHCP lease change
or a laptop moving networks
([certificate-facts.mjs](../apps/server/src/tls/certificate-facts.mjs),
`renewalStatus`/`checkCoverage`). Each strategy owns this check for its own credential
type; `ensure-certificate.mjs` only selects a strategy and forwards the result unchanged.

### Enrolment flow

The host offers the current trust anchor at `/trust`, a page served over plaintext (see
above) that explains what to do with it per platform. `/api/trust/anchor` downloads the
anchor certificate as DER; `/api/trust/status` reports whether TLS is active, which
strategy is in effect, and the anchor's SHA-256 fingerprint. The host UI shows the same
fingerprint and a QR code pointing at `/trust`, so enrolling a device means: open the
page, compare the fingerprint shown there against the one on the host screen, then
install the certificate through the OS's own certificate UI. That fingerprint comparison
is the only integrity check available before trust exists — see Known limitations below.

```mermaid
sequenceDiagram
    participant Device as Client device
    participant Plain as Plaintext listener :4382
    participant TLS as TLS listener :4383
    participant Host as Host UI / CLI

    Note over Plain,TLS: Same request handling, only the transport differs

    Device->>Plain: GET /trust
    Plain-->>Device: enrolment page (unredirected)
    Device->>Plain: GET /api/trust/anchor
    Plain-->>Device: trust anchor certificate + fingerprint
    Note over Device,Host: Device compares fingerprint against Host UI, then installs the anchor

    Device->>Plain: GET /app-route (any other path)
    Plain-->>Device: 307 redirect while HTTPS is live; otherwise 503
    Device->>TLS: GET /app-route (redirect followed)
    TLS-->>Device: response, now warning-free
```

### Known limitations

- **Explicit LAN HTTP is not encrypted.** A valid `off` setting keeps the viewer and
  admission on local HTTP; clients on that network should treat passwords and session
  data as readable by anyone on path. In default auto/provided mode the viewer cannot be
  loaded on HTTP while HTTPS is pending or failed. If an operator changes a running
  deployment's TLS configuration, clients should reload at the advertised viewer URL.
- **Enrolment over plaintext is trust-on-first-use.** Comparing the fingerprint on the
  page against the one on the host screen detects a mismatched or tampered display, but
  does not by itself prove the downloaded certificate file is genuine against a
  fully-controlling on-path attacker on the plaintext LAN segment. The strongest
  available check is comparing the fingerprint the device's own certificate viewer shows
  at install time (where the OS offers one) against the host's screen.
- **The host UI's failure reason is not always specific enough to diagnose.** It can say
  TLS failed and show a port number, but cannot always distinguish "the port is already
  in use" from "no provisioning strategy worked" — check the server log for the precise
  cause.
- **Self-signed reissue invalidates every enrolled device's trust; mkcert's local CA does
  not.** Under `windows-self-signed` the certificate is its own trust anchor, so
  reissuing it — which happens automatically near expiry or when an address changes, or
  manually via "regenerate" in the host UI — means every device that enrolled must enrol
  again. Under `mkcert` the anchor is the stable local CA, so a reissued leaf is still
  trusted without re-enrolling.
- **Provisioning can freeze the server briefly.** Certificate provisioning shells out to
  external tools (mkcert, Windows PowerShell certificate cmdlets) synchronously, which
  can block the server's event loop for up to roughly 150 seconds in the worst case (each
  tool has its own timeout, and they can stack). This happens after local HTTP listeners
  are bound, but viewer admission remains blocked until HTTPS is active unless deliberate
  `off` mode is selected. It can
  happen more than once: at startup, and again on every periodic re-check.
- **A default install still shows a browser warning on devices that have not enrolled.**
  This is expected, not a bug — enrolling a device (visiting `/trust` and installing the
  certificate) is a one-time step per device, not something the server can do for the
  user.

## Repository layout and ownership

```text
apps/
  server/          Node signaling, authentication, worker lifecycle; src/ + tests/
  web-client/      Browser UI and receiver logic; src/ + tests/
  windows-host/    WinUI 3/.NET host, conventional XAML/MSBuild layout
  macos-host/      Planned native Apple server host (ownership guide only)
  windows-client/ Planned WinUI 3 viewer (ownership guide only)
  macos-client/   Planned native Apple viewer (ownership guide only)
native/
  media-worker/   C++ capture/encode/input; src/ + tests/ + CMakeLists.txt
tests/system/     Cross-application lifecycle and real media smoke checks
tools/            Root orchestration and formatting; tools/tests/ owns its tests
  debug/          Cross-process debug target definitions and implementation contract
packaging/        Six-product catalog; shared and OS-specific packaging ownership
docs/             Architecture, mockups, research history
out/              Ignored CMake outputs and preserved legacy artifacts
.deps/            Ignored local SDKs/tools/download cache
```

Tests follow **ownership**, not one mandatory naming convention. JS unit/module
integration tests are inside their app's `tests/`; C++ tests are inside their native
module. App-specific browser tests also belong to that app. Root `tests/system`
is only for checks that exercise the assembled product. A root runner aggregates
tests without taking ownership away from modules.

## Dependency boundaries

- The Node server depends on the web client's exported assets and password helper,
  and the native worker's small exported JS runtime-path adapter.
- Native C++ does not depend on Node. CMake owns its targets, SDK linkage and CTest
  registration. Its private npm manifest only exposes launch configuration and
  its existing Node-driven hardware tests; npm does not compile C++ itself.
- Browser production code does not import the server. Its dev-only server dependency
  supplies a local HTTP fixture for UI smoke tests.
- WinUI owns its MSBuild/XAML project and launches Node through the existing process
  protocol. It does not depend on npm to compile its UI.
- Future Apple apps should use Swift/SwiftUI/AppKit and native Xcode/SPM targets,
  with their own tests. Future Windows viewers should use WinUI 3. The explicitly
  requested ownership scaffolds are not runnable projects; do not invent a shared
  native abstraction before it has users.
- Extract genuinely shared protocol/validation code into a package when needed;
  do not duplicate it or introduce a generic `shared` dumping ground now.
- Encoder knowledge is split deliberately and must stay split. `video-codec.hpp` holds
  bitstream facts that are true of a codec anywhere (caps, parser, payloader, rtpmap);
  `encoder-backend.hpp` holds one row per hardware family, because the four families do
  not agree on property names and AMF does not agree with itself across its own codecs.
  Encoder property strings are built by asking the GStreamer element class what it
  declares, never by concatenating literals: a name an element lacks fails
  `gst_parse_launch` and loses the whole vendor, whereas a skipped property is logged and
  survives. The server learns backends from the probe as data and never names an element.
  Minimum input size belongs to the element, not the codec.

The cross-process JSON/stdin/stdout and WebRTC contracts remain unchanged in this
migration. Stream profiles, H.264/Opus settings, input and session ownership remain
unchanged. Modules resolve resources relative to their own location, not launch CWD.

## Build, dependencies, and tests

One root npm workspace lockfile pins JS dependencies. Use `npm ci` from the root;
no separate nested npm lockfiles. CMake presets coordinate native configurations;
MSBuild remains authoritative for WinUI. Keep generated files out of source control.
GStreamer development headers and runtime DLLs must come from the same SDK install.
Using a custom CMake SDK path requires the matching runtime `GSTREAMER_ROOT` too.

`npm test` is portable and uses stubbed hardware. `npm run test:hardware` explicitly
requires Windows 25H2+, a GPU with a supported hardware encoder (NVIDIA, Intel or AMD)
and an interactive desktop. CTest registers the native unit suites; assert-based checks
remain enabled in Release.
The GitHub Actions workflow `Portable checks` runs formatting and portable tests on
Windows, macOS and Linux. It runs only when started manually from the Actions tab, not
on pushes or pull requests. It does not claim native capture support on those other
OSes or replace device acceptance tests.

Existing opt-in browser checks require an installed Playwright module path:

```powershell
node apps/web-client/tests/toolbar-browser-check.mjs C:\path\to\playwright
node tests/system/browser-media-check.mjs C:\path\to\playwright iphone-720p-test
```

The second captures the real desktop and requires Windows and a hardware encoder.
Chromium with an
iPhone user-agent tests routing, not Safari or iPhone hardware decoding.

## Platform target

Windows SDK 26100 is the compilation target; runtime preflight enforces Windows build
26200 (25H2).
