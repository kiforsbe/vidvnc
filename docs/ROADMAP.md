# VidVNC product roadmap

Updated progress — 2026-09-14. This is sequencing and proposed design, not a claim
that the planned capabilities exist or an approved detailed implementation spec.

## Current baseline

Windows native host uses WinUI 3, with Overview, Displays, Streaming profiles,
Sessions, Access and Settings. Browser viewing, NVIDIA H.264 capture, Opus desktop audio, client input,
profiles, diagnostics and owned-process cleanup exist. The current implementation
admits two devices with up to two video streams each and one audio worker per
device, with host-granted exclusive input permission. Multi-session acceptance is
not complete (see below). Persisted display sharing,
per-display default profiles, secondary capture/input, authenticated switching,
hotplug handling and non-activating Identify labels are implemented. Source display
metadata appears in Sessions and diagnostics. Session cards now have independent
stream graphs and host Grant/Revoke/Stop actions.
Access now persists a keyboard/mouse default for new connections: Require host
approval (initial default) or Allow when available. Automatic grants never displace
another input owner or undo a manual revoke. Existing sessions are unchanged when
the default is saved; browser input enablement remains an explicit client action.
Persisted host profile editing, allowed option lists, audio limits and ordering
are implemented. The refreshed web client offers Automatic or approved profiles;
selection reconnects immediately. Automatic still only selects a starting profile.

UI checkpoint: `3ab158f` adds integrated title bar, Sessions presentation,
sharing status and native navigation regression tests. User accepted its visual
appearance. Debug build and native navigation tests passed before committing.
This does not substitute for DPI/accessibility, device or packaging acceptance.

Web checkpoint: `6ae4529` adds the refreshed pairing/viewer, segmented password
presentation, host-ordered compact profile selector, and authenticated reconnect.

Runtime/access checkpoint: `b328f93` commits the integrated host/session actions,
stream lifecycle changes and saved access defaults. This is an implementation
checkpoint, not completion of the multi-session acceptance gate.

## Current implementation order

1. **Display selection end to end — complete** — sharing policy, per-display defaults,
   secondary capture/input, switching, hotplug handling, Identify and diagnostics.
   User confirmed two-monitor capture/input, unplug/reconnect, restart and iPhone
   acceptance. Per-display allowed-profile restrictions remain a later extension.
2. **Multiple sessions, then multiple streams — integrated; acceptance pending** —
   independent lifecycle, telemetry, resource limits, input ownership and
   session-level audio. Two-client native checks pass on one connected monitor;
   user confirms two-monitor functionality is satisfactory for now. Remaining iPhone
   and combined lifecycle acceptance are not implied by that confirmation. An intermittent
   GStreamer startup warning/timeout also needs investigation before completion.
3. **Finish Windows distribution** — self-contained portable host and CLI bundle,
   then current-user installer and clean-machine acceptance. Can progress in parallel.
4. **Trusted onboarding, native viewers and macOS** — approval, remembered devices,
   revocation, secure discovery, platform-native clients/host and their packages.
5. **Adaptive Automatic quality** — moved after trusted onboarding. Use host-approved
   options to test and adapt during a session; explicit named profiles remain fixed.
6. **Moonlight compatibility exploration** — assess stock Moonlight clients connecting
   to VidVNC as a server. Feasibility/design milestone first, not an implementation promise.

Remote connectivity and the hub remain later, after local trust and lifecycle gates.
The workstreams below describe scope and acceptance, not a competing priority order.

## Product requirements to preserve

- Simple setup, smart defaults, genuinely native Windows/Apple UIs and polished web UI.
- Windows 11 25H2 minimum; macOS 27 with native Apple host and viewer planned.
- Multiple connected devices and multiple server monitors; clients choose which
  streams to view and how to map them onto client windows/monitors.
- Low latency and bounded queues. Keep the working iPhone profiles and transport
  behavior as regression baselines, not permission to reduce quality indefinitely.
- LAN first. Remote access, approved-device discovery and tunneling hub come later.
- Full host/server and separate viewer distributions for each OS, plus CLI server
  bundles. Portable host folders and installers share the same assembled payload.

## Workstreams and acceptance gates

### Display inventory and selectable capture

Selectable-display slice completed on 2026-09-14 with one client and one stream.
The following scope remains the regression baseline for the multi-session work.

- Native worker enumerates physical displays: stable identifier where available,
  name, bounds, primary flag, rotation, scale, resolution and availability.
- Host Displays page draws the real monitor arrangement, with numbered monitor
  tiles, selection state and a details panel. Identify briefly labels the physical
  monitors, only when explicitly invoked. Do not change OS monitor arrangement.
- Distinguish selecting a display for editing from allowing it to be shared.
  Disabled/offline displays remain understandable, not silently substituted.
- Browser lists displays the server permits this session to see. An initial
  default selects the primary permitted display; explicit choices stay explicit.
- Selection flows through validation and worker configuration into real capture.
  Mouse coordinates use the selected display's bounds/rotation, including negative
  desktop coordinates and mixed DPI. Fail safely on stale inventory or unplugging.
- Report the actual selected display in Sessions and diagnostics.

Gate: two attached monitors, one stream switching between them, correct capture
and input on both; unplug/reconnect and server restart; no unintended monitor
exposure; existing iPhone and desktop profile tests still pass.

### Stream configuration that controls negotiation

Introduce versioned configuration and explicit runtime plans; do not let each UI
invent its own interpretation of a profile.

- A **display** is a capture source. A **preset** is reusable quality preferences.
  A **session** is a connected device. A **stream** is a negotiated live delivery
  of a display to that session. Keep these identities separate.
- Persist host sharing policy and default presets in per-user data, not the bundle.
  Offer Automatic, Balanced and low-bandwidth defaults, with advanced controls
  progressively disclosed. Preserve current compatible encoder settings.
- Host Display details show share permission, default quality and effective limits.
  Stream settings show source size versus output size, frame-rate target, bitrate
  budget, codec and audio policy. Explain scaling and letterboxing visually.
- Client requests display IDs and quality preferences, and supplies capabilities.
  Server validates policy and resource limits, then returns the effective plan
  and any fallback reason. Never trust client claims as access authorization.
- Sessions shows requested, negotiated and measured values distinctly. A target
  frame rate must never look like measured delivery.
- Default/policy changes show affected sessions and an explicit Apply action.
  Validate first; retain the previous working configuration when changes fail.
  Decide which changes apply to new sessions and which require renegotiation.

Gate: changing settings demonstrably changes capture/encoding; host limits win;
unsupported client requests receive a useful explanation; configuration survives
restart and migrates safely; failure does not destroy unrelated working sessions.

### Multiple sessions, then multiple streams per session

Integration checkpoint (2026-09-14): latest recorded portable run passed 109 tests.
Synthetic two-browser
tests cover three video streams, separate audio, profile replacement, display
hotplug, telemetry, delayed-heartbeat races and isolated disconnect. Native UI tests
cover stable per-stream graphs and exact owner-pipe action targets. Debug host and
worker build, four CTests, and production startup/shutdown checks pass.
Access-default regression tests cover persistence, stale/invalid writes, admission-time
selection, simultaneous automatic clients, and revocation before/after selection.
Native UI tests save both choices through the owner pipe. Production startup checks
confirm saving defaults leaves connected sessions intact and has no HTTP admin route.

Native two-client/two-audio tests pass on the currently connected monitor, including
ungranted/revoked control rejection and zero remaining test-owned subprocesses.
The normal disconnect SCTP error was reproduced and fixed by stopping the sender
before closing browser peers, while releasing input immediately. A separate
intermittent startup warning in `on_rtpbin_request_aux_receiver` accompanied one
20-second startup timeout; the next unchanged run passed. This is unresolved,
not dismissed by the retry. User subsequently confirmed two-monitor functionality
is satisfactory for now. Record this as user-verified, not an automated hardware
run or confirmation of every audio/input/shutdown scenario. Remaining iPhone and
combined lifecycle acceptance still need confirmation. Implementation is committed through
`b328f93`; the milestone remains acceptance-pending.

- Replace the single-active-worker assumption with a session/stream registry.
  Give every stream explicit lifecycle, ownership and isolated telemetry.
- First prove two independent clients can connect/disconnect without affecting
  each other. Then allow each client to subscribe to multiple allowed displays.
- Start with isolated encoders for correctness and bounded concurrency. Measure
  GPU/encoder capacity and admission control before optimizing capture/encode
  sharing. Sharing an encode is only valid for compatible effective plans.
- Budget bitrate across a session and host; prioritize interactive delivery and
  limit pending frames. Recover stalls without keyframe/retransmission storms.
- Audio is a session-level desktop mix by default, not one duplicated copy per
  monitor stream. Label it accurately; per-application audio is separate scope.
- Enforce a host-visible input owner/lease. View permission and control permission
  are distinct; revoke releases all held keys/buttons. Handle simultaneous input
  requests, disconnects, timeout and host override explicitly.
- Preserve the saved new-connection control default. Automatic permission is a
  one-time opportunity when the first stream is selected, not a waiting queue or
  permission to reacquire control after host revocation. Saving this default must
  not disconnect clients or renegotiate streams.

Gate: two clients with different profiles, two displays, audio without duplication,
correct input routing, per-stream disconnect/recovery, bounded resource use and
zero orphan subprocesses after host exit.

### Client display workspace and native viewers

- Web: clear display switcher, fit/actual-size modes, optional tiled workspace and
  per-stream health. Start video-only subscriptions where control is not granted.
- iPhone: touch-friendly display cards, explicit input mode, orientation handling,
  legible fullscreen toolbar and safe control release. Do not assume desktop
  multi-window/fullscreen APIs exist in mobile Safari.
- Native viewers: WinUI 3 on Windows; native Swift/SwiftUI/AppKit on macOS.
  Map server streams to one or more client windows/monitors, with visual mapping
  previews and remembered layouts. Handle client-monitor removal gracefully.
- Keep transport/configuration contracts shared; presentation and platform
  integration remain native. Browser multi-screen mapping is capability-dependent.

Gate: one and several server displays on different client layouts; reconnect and
monitor removal; keyboard focus and fullscreen/input coexist correctly.

### Trustworthy onboarding and access management

Already implemented: session-password admission, manual input Grant/Revoke and
persisted default input access for new connections. These are control-permission
foundations, not remembered-device trust or host approval of a device's connection.
The onboarding milestone remains open for the following work.

- Easy LAN discovery and QR connection flow, without embedding a durable credential
  in a URL or showing a pairing token to an unauthenticated observer.
- Host approval, remembered devices, revocation and persisted access policy.
- Design HTTPS/trust provisioning before passkeys: raw LAN HTTP is not a complete
  passkey deployment. Evaluate iPhone cross-device authentication as part of that
  design, not merely as a login button.
- Rate limiting, bounded messages, audit events and credential-redacted logs.
  Threat-model local administration, signaling and worker input boundaries.

Gate: first connection and revocation are understandable to nontechnical users;
unauthorized clients cannot enumerate restricted displays or inject input; expired
pairing links and revoked credentials fail safely.

### Distribution and macOS delivery (parallel tracks)

Packaging should continue alongside the display milestone, not wait for all
multi-stream features. Finish the Windows portable host folder and CLI ZIP first,
then wrap the host payload in the approved current-user installer design.
See `PACKAGING.md` and the Windows packaging spec for payload and security gates.

Build the macOS media worker and native host against the same contracts, using
Apple capture/encoding/input APIs with explicit permissions onboarding. Add native
viewers and their separate packages; consider universal Mac binaries when targets
are decided. No Windows-specific manifest or UI assumptions in protocol contracts.

Gate: clean-machine, relocatable, self-contained execution; signing/notarization,
dependency/license inventory, upgrade/uninstall and subprocess cleanup tests.

### Adaptive Automatic quality — priority 5

Host-approved option lists are the adaptive search space, not a manual custom-settings
menu in the web client. Approved-profiles-only mode limits exploration to enabled
profiles; approved-options mode permits validated resolution/frame-rate/bitrate
combinations. Display defaults seed selection; named client choices remain fixed.

- Evaluate sustained delivery, decode stalls, freezes, packet loss, retransmissions,
  jitter and sender buffering. Do not equate low average bitrate with a healthy path.
- Back off when needed; cautiously probe improvements with cooldowns and rollback
  to avoid oscillation. Enforce host policy on every adjustment.
- Investigate live encoder reconfiguration before designing the controller. Do not
  implement repeated full reconnects as the normal adaptation mechanism; identify
  changes that actually require stream restart.
- Show effective settings and adaptation reasons without claiming targets are measurements.

Gate: repeatable changing-network tests and real iPhone acceptance, no uncontrolled
quality oscillation or packet/keyframe bursts, no policy escapes, fixed profiles unchanged.

### Moonlight compatibility — priority 6, exploration

Direction: allow existing, unmodified Moonlight clients to connect to a VidVNC host.
Connecting VidVNC viewers to Sunshine is a different feature and is not included.

Moonlight's core implements NVIDIA GameStream, while Sunshine is an existing
Moonlight-compatible host. This is a separate protocol surface, not simply exposing
our WebRTC endpoint or selecting the same video codec. Primary references:
[Moonlight common core](https://github.com/moonlight-stream/moonlight-common-c) and
[Sunshine](https://github.com/LizardByte/Sunshine).

Explore before selecting an architecture:

- Discovery/manual host addition, pairing and trust, host/application listing,
  launch/resume/stop, media negotiation, video/audio transport, input and recovery.
- Compare a VidVNC-owned compatibility adapter with controlled Sunshine integration;
  evaluate maintenance, licensing/redistribution, process ownership and packaging.
  Do not assume client-side Moonlight code is a reusable server implementation.
- Reuse display policy, effective stream plans, capture/encoding and input ownership
  where technically feasible. Compatibility must not bypass VidVNC authorization,
  expose unshared displays, or grant unrestricted process launch.
- Start with one approved desktop/display, H.264, audio and keyboard/mouse on LAN.
  Investigate controller support separately; do not imply initial HDR, HEVC/AV1,
  arbitrary app launching or simultaneous multi-display compatibility.
- Map Moonlight's requested settings to host limits; explicitly investigate how
  negotiation and adaptation constraints differ from the WebRTC client.

Exploration gate: documented protocol/dependency/license assessment, recommended
architecture and a bounded interoperability proof using stock Moonlight on iPhone
and a desktop. Verify pairing/revocation, media, input, reconnect and cleanup without
regressing the browser path. User approval of that design precedes product implementation.
Any new host UI receives an approved preview first. No code adoption or distribution
decision is made by this roadmap entry.

### Remote connectivity and hub — later

Only after local identity, authorization and lifecycle work reliably: approved
device registration, authenticated rendezvous, direct connection where possible,
relay/tunnel fallback, revocation and operational limits. Do not expose current
HTTP pairing directly to the Internet. Keep the hub out of local-only operation.

## Proposed configuration/selection contract

Host policy plus display inventory establish what may be streamed. Client
capabilities plus user preferences establish what is requested. The server builds
an effective stream plan within policy and hardware limits; the worker executes
that plan and reports actual state. Host and clients visualize that same state.

Candidate identifiers: `displayId`, `presetId`, `sessionId`, `streamId`, plus
configuration/inventory revisions. These are proposed schema concepts, not a
final wire format. Public IDs must not double as bearer credentials.

Define messages, validation, errors, version negotiation, switching transactions
and lifecycle tests before implementing a shared contract package. The current
owner pipe stays the native host's administration boundary; no unauthenticated
network administration endpoint should be introduced for UI convenience.

## Immediate next steps

1. Investigate the intermittent GStreamer `on_rtpbin_request_aux_receiver` warning
   and startup timeout with repeated, instrumented startup runs. Preserve current
   quality settings; an unchanged successful retry is not a fix.
2. Two-monitor functionality is user-verified and accepted for now; do not block on
   repeating that check. Finish the remaining combined two-client acceptance,
   including iPhone touch/fullscreen, input routing and default/manual permission
   behavior, independent stops, audio, hotplug and host-exit cleanup. Only mark
   those individual scenarios verified when supported by tests or user confirmation.
3. Record results and close milestone 2 only when its gates pass. Existing registry,
   lease, audio, host actions and graphs do not need another design pass. New Windows
   host UI changes still require an approved preview.
4. Continue milestone 3: finish Windows portable host/CLI payloads, current-user
   installer and clean-machine acceptance. This can proceed in parallel with
   hardware acceptance; milestones 4–6 retain their current order.
