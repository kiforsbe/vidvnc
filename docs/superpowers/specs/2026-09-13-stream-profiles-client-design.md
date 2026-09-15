# Streaming profiles, display defaults and web experience

Status: visual direction approved by the user; implementation authorized.

## Visual references and scope

Use `docs/design/stream-policy-client-v1/streaming-profiles-v3.png` for profile
rows and the create/edit dialog. Use `displays-profile-defaults-v2.png` for display
defaults, `web-pairing-v1.png` for pairing, and `web-viewer-v1.png` for the viewer.
The existing native navigation/chrome and sharing indicator remain authoritative.
The generated modal shown beside the page is a separate view, not a side panel.
Do not copy invented profile values, duplicate labels, domains or security claims.
Web appearance supports System (default), Light and Dark. System changes apply
live unless explicitly overridden. Never recolor streamed desktop pixels.

Windows 11 25H2/NVIDIA is the first implementation target. Keep protocol/data
contracts independent of WinUI for later macOS 27/native Apple UI consumers.
No subagents; work in the existing approved feature checkout. Packaging unchanged.

## Native profiles page

Add Streaming profiles immediately after Displays. Rows contain a left-hand
availability toggle, name with description below, then output dimensions, fps,
video bitrate and ellipsis grouped toward the right. Keep standard host spacing.
The ellipsis offers Edit, Duplicate and Remove. New profile and Edit open the same
native ContentDialog with name, description, dimensions, fps, bitrate, fixed or
variable delivery, availability and Save/Cancel. Variable remains disabled until
implemented and verified; do not add unsupported-feature labels. Validate and
show inline errors without discarding the user's draft. Never optimistically show
a saved state before server acknowledgment.

Profiles start from the five current presets, retaining internal IDs and numeric
settings. Display names and descriptions are user-editable, IDs are not. Deleting
or disabling a referenced default is rejected until defaults are reassigned;
UI explains which references prevent the action. Do not silently change defaults.
Disabling a profile cannot leave an active unauthorized stream running.

## Display defaults and permissions

Displays retains the monitor map and sharing rows. A global Default profile is
used when a display has no override. Each display can select Use default (with
the effective name) or an explicit permitted profile. Defaults do not authorize
sharing. Additional monitors require opt-in. Per-display allowed-profile lists
are a separate subsequent capability; its placeholder stays disabled.
Host audio permission overrides client preference; a client may decline/mute
permitted audio but may not request audio the host forbids. Audio is one desktop
mix per session, not one mix per monitor.

## Server-owned configuration

Keep a versioned per-user JSON configuration outside the installed bundle.
Schema v1 contains revision, profiles, defaultProfileId (initially auto to preserve
the working iPhone/desktop defaults), displayDefaults, allowAudio, clientMode and
allowedOptions. Profile records: id, name, description, enabled, width, height,
fps, bitrateKbps, frameDelivery. Limits for the first validated fixed-rate slice:
64 profiles; names 1–64 characters; descriptions 0–240; even dimensions 64–4096;
fps integer 1–60; video bitrate 100–50000 kbit/s. These are validation bounds,
not hardware guarantees. Hardware capability validation is an additional gate.
Transport MTU and encoder tuning are not editable profile fields.

Allowed options contain explicit resolution pairs, fps values and bitrate values.
Approved profiles only is the initial mode. Approved options additionally allows
a client custom request only when each value is in its corresponding host list;
the effective combination still passes codec/device/aspect-ratio validation.
Fixed is initially the only supported delivery mode. Variable means fewer frames
when idle under an approved upper cap, not display VRR or guaranteed adaptation.
Keep it separate from the known-working capture/encoder/timestamp behavior.

Profile selection order: explicit permitted client profile/custom request;
display default; global default; auto compatibility selection among enabled
profiles. Auto prefers the existing iPhone baseline on Apple mobile browsers and
desktop otherwise, falling back only among enabled profiles. An explicit invalid
or denied request fails, never silently becomes auto. Return an immutable copy of
the effective plan with source of selection and configuration revision.

Use optimistic revision checks, serialized saves and same-directory atomic rename.
Validate before writing. A failed write leaves memory and previous file unchanged.
Never silently replace a malformed/future-schema file with permissive defaults.
Bound file/message sizes and reject duplicate IDs, bad references and unknown keys.
Read-only snapshots must not expose mutable internal state.

## Integration boundaries

Owner stdin/stdout remains the host administration boundary: bounded correlated
configuration requests, revisioned updates, success/error acknowledgments. No
network configuration-write endpoint. Authenticated clients receive permitted
inventory and profile choices. Resolve again at offer time, not only at login.
Media workers receive explicit validated numeric plans rather than switching only
on hardcoded profile names. Validate again in native code before building a
pipeline. Never interpolate arbitrary client strings into GStreamer descriptions.

Changes to profiles used by active media must explicitly restart/revoke affected
streams or await a user-approved deferred apply; acknowledgments describe the
effect. Release input and retire the worker before replacement. Failed initial
validation preserves the current stream; post-teardown failure is recoverable
without capturing a different display. Sessions/diagnostics show actual selection
and distinguish configured targets from measured results.

## Pairing and browser viewer

Eight visual password cells over one semantic text input. Preserve typing, paste,
caret/selection, deletion, keyboard access and screen-reader labeling. Normalize
case and optional dash; no spellcheck or autocorrect. Fictional sample letters
are not credentials. Respect existing authentication/rate limiting and no-store
behavior. Do not enumerate monitors before authentication.

Retain the video element, true aspect ratio, stage sizing, audio element and
flush-top fullscreen toolbar behavior. Replace surrounding shell with the approved
responsive design: compact host/status header, permitted display picker, quality
choice and progressively disclosed connection details. Keep full-screen/input
release and iPhone touch behavior. Display only capabilities authorized by host.
System theme follows prefers-color-scheme, light fallback, with explicit optional
System/Light/Dark override. Preserve focus contrast and reduced-motion behavior.

## Acceptance

Test configuration validation, restart persistence, stale revisions, failed writes,
unknown/future files, mutations through snapshots, denied/custom requests, profile
removal references and host audio denial. Native tests cover six-page navigation,
modal validation/cancel/save/error, compact layout and long labels. Browser tests
cover single-input password interactions and light/dark switching. Two physical
monitors and real iPhone/desktop playback remain required before declaring the
full display/profile slice done. New variable-rate and concurrency work require
their own performance/regression acceptance; no claim from mockups alone.
