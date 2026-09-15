# Display selection and stream planning — proposed design

Status: design review. Companion: `docs/design/display-stream-preview.html`.
The companion is an interactive design model, not a native app screenshot or
live administration surface. Its policy editor previews milestone 2.

## Accepted visual direction

User confirmed `docs/design/windows-host-previz/displays-v1.png` as the visual
reference. It takes precedence over the simplified interactive companion for
native host presentation:

- Keep the existing native WinUI title bar, navigation and sharing indicator.
- Large monitor arrangement panel, with numbered tiles sized and oriented from
  actual desktop bounds; support landscape beside portrait, not only two landscape
  screens. Tile selection and row selection stay synchronized.
- Identify displays action at the page header; explicit invocation only.
- Expandable per-display rows below the map: icon, friendly name, primary badge,
  source resolution/refresh rate, sharing switch and stream settings details.
- Streaming defaults below: quality, stream frame-rate target and desktop audio.
  Retain an explicit Apply action for pending settings and explain affected sessions.
- Clients choose from allowed displays. Local OS display settings remain unchanged.
- Monitor refresh rate and encoded stream frame-rate target are separate values.
  Do not copy the concept's adaptive-quality claim until such adaptation exists.
- Use neutral/themed monitor artwork initially, not live desktop thumbnails that
  capture or reveal a display before sharing authorization. The wallpaper in the
  concept is illustrative, not a required bundled asset.

Use native WinUI controls and semantic theme resources. Reflow/scroll at small
window sizes and large text rather than scaling the reference image or resizing
the window on each page change. The image's dimensions and display count are sample
data, never defaults hardcoded into the product.

## Decision

Build one selectable display end to end first, then add effective stream policy,
then concurrency. A UI-only monitor map would not solve capture/input selection;
implementing multi-client, multi-monitor encoding at once would make failures
harder to isolate. The single-stream slice is an implementation sequence, not a
change to the multi-user/multi-monitor product goal.

## First slice

1. Worker enumerates displays and reports an inventory revision, opaque display
   IDs, bounds, rotation, primary state and supported capture capability.
2. Server owns allowed-display policy and validates every requested display against
   current inventory. Host edits policy via its owned pipe, not a public admin API.
3. Host renders the actual desktop arrangement. Clicking a tile selects its settings;
   it does not change sharing or rearrange Windows monitors. Apply persists policy.
4. Authenticated browser receives only allowed displays and requests a display ID
   alongside the existing profile. Unauthenticated info must not expose inventory.
5. Server resolves display plus profile into a stream plan. Worker captures that
   display; input is mapped to its desktop bounds, not blindly to the primary screen.
6. Sessions identifies the actual display and target versus measured stream values.

Initial policy keeps the primary display allowed for compatibility; additional
displays require host opt-in. New or ambiguously identified displays default to
not shared. Display numbers are presentation labels, never persistent identity.
Inventory IDs must be mapped to verified native capture targets; do not assume
Windows enumeration order equals GStreamer monitor index order.

## Switching and failure behavior

First slice may use controlled stream restart and browser renegotiation rather
than seamless switching. Release held input, invalidate the old stream generation,
stop the old worker, then start the validated target. Reject stale commands.
Prevalidation failures retain the current stream. If startup fails after teardown,
show a recoverable error and offer the previous permitted display; do not silently
capture another display. Unplugging or revoking sharing stops capture/control and
returns the client to its picker. Display topology changes invalidate input mapping.

Audio remains one desktop mix per session, not isolated audio from the selected
monitor. Explain this wherever audio permission is configured.

## Next slice: real quality policy

Separate display identity, reusable preset, session, and live stream identity.
Persist host defaults/limits with schema revisions and atomic writes. Resolve
client capabilities/preferences under host limits into an effective stream plan;
return adjustments and reasons. Preserve aspect ratio and compatible encoder
settings. Automatic selection remains based on current tested behavior initially,
not a claim of adaptive congestion control.

UI must distinguish source resolution, output resolution, requested quality,
negotiated settings and measured delivery. Apply shows affected sessions and
whether reconnect is needed. The preview demonstrates this relationship; its
numeric limits are examples, not a finalized negotiation algorithm.

## Ownership and tests

- Native module: display enumeration/capture target resolution, coordinate mapping,
  rotation/DPI behavior, input release and worker lifetime tests.
- Server: authenticated inventory filtering, policy persistence, request validation,
  stale revisions and stream generation/rollback behavior.
- Host: spatial map layout, keyboard selection, editing versus Apply, missing
  displays and repeated navigation without reparenting crashes.
- Browser: picker state, unavailable targets, switching, reconnect and letterboxing
  input transforms; actual Safari/iPhone acceptance in addition to automated tests.
- System: two physical displays with negative coordinates/mixed DPI where available,
  capture and input on each, hot unplug, sharing revocation, restart, audio and
  orphan-process checks. Windows 25H2/NVIDIA remains the first implementation target.

No permission changes, media code changes or new endpoints are implemented by this
design document. Multi-stream delivery and client monitor mapping follow separately.

## Approved revision: flat display settings (2026-09-13)

Approved reference: `docs/design/windows-host-previz/displays-flat-defaults-v2.png`.
Preserve the existing native shell. Display expanders contain flat Default profile
and Allowed profiles rows separated by a rule, never nested cards. Allowed profiles
remains disabled until per-display restrictions are implemented. Host defaults is
one flat card with Default profile and Desktop audio rows; the heading is outside.
The audio switch is host permission, not a client preference. Apply/Cancel sit in
the footer with Connect a device. Edits are drafts until explicit Apply, using the
same revisioned owner-pipe policy transaction as streaming profiles. Failed saves
retain the draft and report the failure. Applying disconnects active clients after
confirmation; cancel must not change persisted settings or active streams.
