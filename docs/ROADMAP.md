# VidVNC roadmap

Updated for 0.1.0 (2026-09-15). This roadmap describes the order and direction of
planned work. It is not a promise that a planned feature will ship, or when. For what
each release contains, see the [changelog](../CHANGELOG.md).

## Where 0.1.0 stands

Implemented:

- A Windows 11 25H2 server with DXGI capture, Opus desktop audio and a browser client
  served by the server.
- Multi-vendor hardware encoding: NVENC, Intel Quick Sync, AMD AMF and Windows Media
  Foundation, chosen per machine with a preference for the GPU that captured the frame,
  and overridable from the host. A backend is advertised only after passing a real
  short encode, and encoder properties are read from the element at runtime rather than
  assumed, because the four families do not agree on property names -- AMF does not
  even agree with itself across its own codecs.
  NVENC, AMF and Media Foundation were exercised on real hardware (an NVIDIA RTX 5060
  Ti and an AMD Radeon integrated GPU). **Quick Sync remains untested**: no Intel
  graphics was available. Promoting it from untested to supported needs an Intel
  machine and, on it: the self-tests across H.264, H.265 and AV1 in both CBR and VBR;
  the VBR bitrate measurements that produced the NVENC quality floors, repeated to
  confirm the rescaled floors behave; and a latency measurement in particular, since
  Quick Sync is the one family with no low-latency or target-usage property at all and
  its latency comes only from CBR, one reference frame, no B-frames and a short GOP.
- Display selection: per-display sharing and default profiles, switching between
  shared displays, handling for displays being plugged in or removed, and Identify
  labels. Sessions and diagnostics show each stream's source display.
- Streaming profiles with editing, ordering and audio limits, plus host-approved size,
  frame-rate and bitrate options. Clients choose Automatic or an approved profile;
  Automatic only chooses a starting profile.
- Up to two devices, each with up to two video streams and one audio stream. One
  device at a time has keyboard and mouse control. The host grants, revokes and stops
  streams, and new connections either wait for approval or get control when it's free.
- A WinUI 3 app for the host and a command-line server that can change the same
  settings.
- Windows development packages: the VidVNC Server ZIP (unsigned) and the VidVNC app
  MSIX (signed with a self-signed development certificate).

Still open in 0.1.0:

- Multi-device acceptance is not finished; see
  [Multiple devices and streams](#multiple-devices-and-streams).
- An intermittent GStreamer warning in `on_rtpbin_request_aux_receiver` once came with
  a 20-second startup timeout. The next unchanged run passed, but the cause is unknown.

## Milestones

1. **Display selection — done.** Per-display restrictions on allowed profiles remain
   a later extension.
2. **Multiple devices and streams — implemented, acceptance pending.** Independent
   lifecycle, telemetry, resource limits, input ownership and session-level audio.
3. **Windows distribution — development builds available.** Remaining: clean-machine
   acceptance, trusted signing, upgrade and uninstall checks, and published releases.
   Runs in parallel with milestone 2.
4. **Trusted onboarding, native viewers and macOS** — host approval of devices,
   remembered devices, revocation, secure discovery, native viewers, a native macOS
   host, and their packages.
5. **Adaptive Automatic quality** — adapt within host-approved options during a
   session; named profiles stay fixed.
6. **Moonlight compatibility exploration** — assess whether stock Moonlight clients
   can connect to VidVNC as a server. A feasibility and design milestone first, not a
   promise to implement it.

Remote connectivity and the hub come later, after local trust and lifecycle work. The
sections below describe the scope and acceptance criteria for each area; they don't
change this order.

## Product principles

- Simple setup, smart defaults, native Windows and Apple apps, and a polished web UI.
- Windows 11 25H2 minimum; a native macOS 27 host and viewer are planned.
- Multiple connected devices and multiple server displays. Clients choose which
  streams to view and how to arrange them on their own windows and monitors.
- Low latency and bounded queues. The working iPhone profiles and transport behavior
  are regression baselines, not a reason to keep quality low.
- Local network first. Direct remote access for approved devices exists as an opt-in;
  approved-device discovery and a tunneling hub come later.
- A server app, a viewer and a command-line server package for each OS. The server
  app and the command-line server share the same server payload.

## Workstreams and acceptance criteria

### Display selection

Done in 0.1.0 with one client and one stream. This behavior is now the regression
baseline for later work:

- The native worker lists physical displays with a stable identifier where available,
  name, bounds, primary flag, rotation, scale, resolution and availability.
- The host's Displays page draws the real monitor arrangement with numbered tiles,
  selection state and a details panel. Identify briefly labels the physical monitors,
  only when asked. VidVNC never changes the OS monitor arrangement.
- Selecting a display for editing is separate from allowing it to be shared.
  Disabled or offline displays stay visible and are never silently substituted.
- The browser lists only displays the server lets this session see. By default it
  selects the primary permitted display; explicit choices stay explicit.
- Selection flows through validation and worker configuration into real capture.
  Mouse coordinates use the selected display's bounds and rotation, including
  negative desktop coordinates and mixed DPI. Stale inventory and unplugging fail
  safely.
- Sessions and diagnostics report the display actually being captured.

Acceptance (met): two attached monitors, one stream switching between them, correct
capture and input on both; unplug and reconnect, and server restart; no unintended
monitor exposure; existing iPhone and desktop profile tests still pass.

### Stream configuration that controls negotiation

Implemented so far: saved sharing policy, per-display default profiles, profile
editing and host-approved options. The rest of this section is design direction.
Configuration is versioned and turned into explicit runtime plans, so that no UI
invents its own interpretation of a profile.

- A **display** is a capture source. A **profile** is a reusable set of quality
  preferences. A **session** is a connected device. A **stream** is a negotiated live
  delivery of a display to that session. These identities stay separate.
- Host sharing policy and default profiles are stored in per-user data, not in the
  package. Offer Automatic, Balanced and low-bandwidth defaults, with advanced controls
  shown progressively. Keep current compatible encoder settings.
- The host's display details show share permission, default quality and effective
  limits. Stream settings show source size versus output size, frame-rate target,
  bitrate budget, codec and audio policy, and explain scaling and letterboxing
  visually.
- Clients request display IDs and quality preferences and describe their
  capabilities. The server validates policy and resource limits, then returns the
  effective plan and any fallback reason. Client claims never authorize access.
- Sessions shows requested, negotiated and measured values distinctly. A target frame
  rate must never look like measured delivery.
- Changes to defaults or policy show the affected sessions and an explicit Apply
  action. Validate first, and keep the previous working configuration when a change
  fails. Decide which changes apply only to new sessions and which renegotiate.

Acceptance: changing settings demonstrably changes capture and encoding; host limits
win; unsupported client requests get a useful explanation; configuration survives
restart and migrates safely; a failure doesn't break unrelated working sessions.

### Multiple devices and streams

Implemented: a session and stream registry, per-stream lifecycle and telemetry,
isolated encoders, session-level audio, a host-visible input owner with Grant and
Revoke, and the saved control default for new connections.

Automated tests cover:

- two simulated browsers with three video streams, separate audio, profile changes,
  display hotplug, telemetry, delayed-heartbeat races and isolated disconnects;
- stable per-stream graphs and host actions in the native host UI;
- saved access defaults: persistence, stale or invalid writes, selection when a device
  connects, simultaneous automatic clients, and revocation before and after selection;
- native runs with two clients and two audio streams on one monitor, including
  rejected input without control and no leftover test processes.

A disconnect error in SCTP was fixed by stopping the sender before closing browser
peers, while still releasing input immediately. Two-monitor use has been checked by
hand, not by automated hardware runs.

Still to verify with two clients: iPhone touch and the in-page full-screen mode, input
routing with automatic and manual control, independent stops, audio, display hotplug,
and cleanup when the host exits.

Design:

- Every stream has an explicit lifecycle, owner and isolated telemetry.
- Two independent clients connect and disconnect without affecting each other; each
  client can then subscribe to several allowed displays.
- Start with isolated encoders for correctness and bounded concurrency. Measure GPU
  and encoder capacity and add admission control before sharing capture or encoding.
  Sharing an encode is only valid for compatible effective plans.
- Budget bitrate across a session and the host; prioritize interactive delivery and
  limit pending frames. Recover from stalls without keyframe or retransmission storms.
- Audio is a session-level desktop mix by default, not a copy per monitor stream, and
  is labeled accurately. Per-application audio is separate scope.
- View permission and control permission are distinct. Revoking control releases all
  held keys and buttons. Simultaneous input requests, disconnects, timeouts and host
  overrides are handled explicitly.
- The saved control default for new connections is a one-time opportunity when the
  first stream is selected, not a waiting queue or permission to take control back
  after the host revokes it. Saving the default never disconnects clients or
  renegotiates streams.

Acceptance: two clients with different profiles, two displays, audio without
duplication, correct input routing, per-stream disconnect and recovery, bounded
resource use and no orphaned processes after the host exits.

### Client display workspace and native viewers

- Web: a clear display switcher, fit and actual-size modes, an optional tiled
  workspace and per-stream health. Start with video-only subscriptions where control
  isn't granted.
- iPhone: touch-friendly display cards, an explicit input mode, orientation handling,
  a legible fullscreen toolbar and safe control release. Don't assume desktop
  multi-window or fullscreen APIs exist in mobile Safari. Started: with keyboard and mouse
  on, the stage fills the screen inside the page (Safari's only full screen is its video
  player, which takes input away), and from the Home Screen VidVNC runs without Safari's
  bars.
- Native viewers: WinUI 3 on Windows; Swift, SwiftUI and AppKit on macOS. Map server
  streams to one or more client windows or monitors, with visual mapping previews and
  remembered layouts. Handle a client monitor being removed gracefully.
- Transport and configuration contracts are shared; presentation and platform
  integration stay native. Browser multi-screen mapping depends on browser support.

Acceptance: one and several server displays on different client layouts; reconnect
and monitor removal; keyboard focus, fullscreen and input work together correctly.

### Trustworthy onboarding and access management

Already implemented: password admission, manual Grant and Revoke of input, and a saved
default for input access on new connections. These are the basis for control
permissions, not remembered-device trust or host approval of a device's connection.

**HTTPS and trust provisioning are done.** VidVNC now provisions its own certificate
automatically (preferring an operator-supplied certificate, then mkcert's local CA, then
a Windows self-signed certificate), serves a device-aware enrolment page and fingerprint
check at `/trust`, and shows TLS status in both the host UI and the CLI. See
[ARCHITECTURE.md](ARCHITECTURE.md#tls-and-trust-provisioning) for the detail. `off` mode
still restores today's plain-HTTP behaviour for anyone who wants it unchanged. This
unblocks passkeys but does not implement them.

Planned:

- Easy local discovery and a QR connection flow, without putting a durable credential
  in a URL or showing a pairing token to an unauthenticated observer.
- Host approval, remembered devices, revocation and saved access policy.
- Passkeys and WebAuthn, now that a secure context is available by default. Evaluate
  iPhone cross-device authentication as part of that design, not merely as a login
  button.
- Rate limiting, bounded messages, audit events and logs with credentials redacted.
  Threat-model local administration, signaling and the worker's input boundary.

Acceptance: first connection and revocation are understandable to nontechnical users;
unauthorized clients can't list restricted displays or inject input; expired pairing
links and revoked credentials fail safely.

### Distribution and macOS

Windows development builds exist: the VidVNC Server ZIP (unsigned) and the VidVNC app
MSIX (self-signed). Both bundle VidVNC's own components and media libraries; general
runtimes are prerequisites the user installs. See [PACKAGING.md](PACKAGING.md).
Remaining for Windows: clean-machine acceptance, trusted signing, upgrade and uninstall
checks, published releases with license notices and source for the bundled LGPL
libraries, and the native viewer package.

Build the macOS media worker and native host against the same contracts, using Apple
capture, encoding and input APIs with explicit permission onboarding. Add native
viewers and their separate packages; consider universal Mac binaries once targets are
decided. Protocol contracts contain no Windows-specific manifest or UI assumptions.

Acceptance: install and run on a clean machine with only the declared prerequisites;
the command-line server runs from any folder; signing (and notarization on macOS);
dependency and license inventory; upgrade, uninstall and process cleanup tests.

### Adaptive Automatic quality

Host-approved option lists are the search space for adaptation, not a manual custom
settings menu in the web client. Approved-profiles mode limits exploration to enabled
profiles; approved-options mode allows validated combinations of resolution, frame
rate and bitrate. Display defaults seed the selection; named client choices stay
fixed.

- Evaluate sustained delivery, decode stalls, freezes, packet loss, retransmissions,
  jitter and sender buffering. A low average bitrate doesn't mean the path is healthy.
- Back off when needed, and probe improvements cautiously with cooldowns and rollback
  to avoid oscillation. Enforce host policy on every adjustment.
- Investigate live encoder reconfiguration before designing the controller. Repeated
  full reconnects must not be the normal way to adapt; identify which changes really
  need a stream restart.
- Show effective settings and adaptation reasons without presenting targets as
  measurements.

Related work: the [variable frame rate and bitrate
investigation](investigations/VARIABLE-RATE-INVESTIGATION.md) found that the encoder
properties for bitrate, peak, quality floor and GOP length are changeable while streaming.
Changing them mid-stream has not been exercised yet. The [variable bitrate
design](superpowers/specs/2026-09-20-variable-bitrate-design.md) adds opt-in variable
bitrate profiles. All shipped profiles stay constant bitrate until loss recovery and
long-GOP decoding are checked on a real iPhone.

Acceptance: repeatable tests on changing networks and real iPhone testing; no
uncontrolled quality oscillation or packet and keyframe bursts; no policy escapes;
fixed profiles unchanged.

### Moonlight compatibility (exploration)

Direction: let existing, unmodified Moonlight clients connect to a VidVNC host.
Connecting VidVNC viewers to Sunshine is a different feature and isn't included.

Moonlight's core implements NVIDIA GameStream, and Sunshine is an existing
Moonlight-compatible host. This is a separate protocol surface, not a matter of
exposing the WebRTC endpoint or using the same video codec. References:
[Moonlight common core](https://github.com/moonlight-stream/moonlight-common-c) and
[Sunshine](https://github.com/LizardByte/Sunshine).

Explore before choosing an architecture:

- Discovery or manual host addition, pairing and trust, host and application listing,
  launch, resume and stop, media negotiation, video and audio transport, input and
  recovery.
- Compare a VidVNC-owned compatibility adapter with controlled Sunshine integration,
  weighing maintenance, licensing and redistribution, process ownership and
  packaging. Client-side Moonlight code is not a reusable server implementation.
- Reuse display policy, effective stream plans, capture, encoding and input ownership
  where feasible. Compatibility must not bypass VidVNC authorization, expose unshared
  displays or allow unrestricted process launching.
- Start with one approved display, H.264, audio, and keyboard and mouse on the local
  network. Investigate game controllers separately; don't imply HDR, HEVC or AV1,
  arbitrary app launching or multiple displays at first.
- Map Moonlight's requested settings to host limits, and investigate how its
  negotiation and adaptation constraints differ from the WebRTC client's.

Exploration is complete with a documented protocol, dependency and license assessment,
a recommended architecture, and a bounded interoperability proof using stock Moonlight
on iPhone and a desktop. It must verify pairing and revocation, media, input,
reconnect and cleanup without regressing the browser client. A reviewed design comes
before any implementation, and this entry doesn't commit to adopting code or shipping
the feature.

### Remote connectivity and hub

Direct remote access exists as an opt-in: the router forwards HTTPS and a fixed media port
range, and internet clients can only sign in as approved devices set up on the LAN (see
[remote access](security/remote-access.md)). Pairing, codes and certificate enrolment stay
on the local network. It has streamed through one real router; a packet capture and an
IPv6 run remain (R8 in the [security analysis](security/internet-exposure.md)).

Later, and only after local identity, authorization and lifecycle work reliably:
authenticated rendezvous, relay or tunnel fallback for networks where port forwarding
can't work (carrier NAT), and passkeys for approved devices. Local-only use never depends
on the hub.

## Proposed configuration and selection contract

Host policy plus display inventory establish what may be streamed. Client capabilities
plus user preferences establish what is requested. The server builds an effective
stream plan within policy and hardware limits; the worker executes that plan and
reports its actual state. The host and clients show that same state.

Candidate identifiers: `displayId`, `profileId`, `sessionId`, `streamId`, plus
configuration and inventory revisions. These are proposed schema concepts, not a final
wire format. Public IDs must never double as bearer credentials.

Define messages, validation, errors, version negotiation, switching transactions and
lifecycle tests before building a shared contract package. The native host's owner
pipe and the command-line server's console remain the administration boundaries; no
unauthenticated network administration endpoint is added for UI convenience.

## Next steps

1. Investigate the intermittent GStreamer `on_rtpbin_request_aux_receiver` warning and
   startup timeout with repeated, instrumented startup runs. Keep current quality
   settings; an unchanged successful retry is not a fix.
2. Finish multi-device acceptance: iPhone touch and the in-page full-screen mode, input
   routing with automatic and manual control, independent stops, audio, hotplug and
   cleanup when the host exits. Mark a scenario verified only when a test or a hands-on check
   supports it, and close milestone 2 when its acceptance criteria pass.
3. Close R8 for remote access: a phone confirmed on mobile data, an IPv6 run and a
   packet capture.
4. Continue Windows distribution in parallel: clean-machine acceptance, trusted signing,
   upgrade and uninstall checks, and the first published release.
5. New Windows host UI starts with a design preview in [docs/design](design) before it
   is built.
