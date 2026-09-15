# Display Selection Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans inline, without subagents,
> in the existing user-approved feature checkout.

**Goal:** Select an allowed physical display through native host and browser UI,
and capture/control that display with safe lifecycle behavior.

**Architecture:** Native inventory maps opaque display IDs to current HMONITOR
handles. Server policy filters inventory and validates stream requests. Host and
browser consume the same display records; each worker resolves its target anew.

**Tech Stack:** C++/Win32/GStreamer, Node ESM, WinUI 3/C#, browser JavaScript.

**Spec:** `docs/superpowers/specs/2026-09-13-display-selection-design.md`

## Constraints

Windows 11 25H2/NVIDIA first; one session and one stream initially. Additional
displays are denied until explicitly shared. Never infer GStreamer index order
from Windows monitor enumeration. Do not change working codec/transport defaults.
Do not expose display inventory before authentication. Keep settings separate from
program files. Run native tests without terminating an existing user session.

## 1. Native inventory and capture-coordinate contract

Files: new `native/media-worker/src/display-inventory.hpp`,
`native/media-worker/src/display-coordinates.hpp`,
`native/media-worker/tests/display-coordinates.cpp`; existing `media-worker.cpp`
and native `CMakeLists.txt`.

- [ ] Add failing pure tests for mapping display-relative points into the virtual
  desktop's absolute range, including a monitor left of primary and boundaries.
  Expected: left monitor midpoint in a 3840-wide desktop maps near 16384, not 32768.
- [ ] Implement `desktop_point(x,y,display,desktop)` with finite/range validation;
  map source pixels to virtual-desktop coordinates. Run the native test target.
- [ ] Enumerate active monitors using Win32, collect opaque device identity, physical
  desktop bounds, primary flag, refresh and rotation. Emit inventory in `--probe`.
- [ ] Add `--list-displays` for lightweight topology refresh without media preflight.
  Bind actual capture through `monitor-handle`, not guessed indices. Resolve only
  exact identifiers and fail on stale/missing targets.
- [ ] Run Debug build, CTest and inspect real enumeration; checkpoint this layer.

## 2. Validated server display policy

Files: new `apps/server/src/displays.mjs`, `apps/server/tests/displays.test.mjs`;
existing `main.mjs`, `http-app.mjs`, `native-media.mjs`, `session-store.mjs`.

- [ ] Test primary-only defaults, unknown ID rejection, denied ID rejection,
  inventory revision changes and no unauthenticated enumeration.
- [ ] Implement a revisioned inventory/policy store; atomic per-user JSON writes.
  On identity change do not transfer sharing permission by display number.
- [ ] Add authenticated display listing and validated selection at offer time;
  pass selected ID into the worker offer. Return actual selection in status.
- [ ] Handle topology removal and permission revocation by stopping affected media
  and releasing input. Reject stale revisions before starting a replacement stream.
- [ ] Run app-owned tests and cross-process authenticated selection checks.

## 3. Native Displays page

Files: new `apps/windows-host/HostWindow.Displays.cs`; existing host layout and
owned-pipe dispatcher, native Navigation regression project.

- [ ] Test landscape/portrait/negative-origin layout fitting, selection without
  permission mutation, explicit Apply and missing-display handling.
- [ ] Render native monitor map and expandable rows from owned inventory, matching
  `docs/design/windows-host-previz/displays-v1.png`. No fake wallpaper captures.
- [ ] Wire sharing controls to revisioned owned commands; show failures and pending
  edits rather than optimistically claiming permission changed.
- [ ] Add explicitly invoked, bounded Identify overlays with no capture dependencies.
- [ ] Run native regression tests and inspect layout at normal and compact sizes.

## 4. Browser picker, switching and integration

Files: browser `src/app.js`, `src/index.html`, module-owned browser tests;
server HTTP tests and root `tests/system` integration tests.

- [ ] Test authenticated permitted choices, no displays, stale selection and
  deselection on revocation. Preserve the existing primary default for old flows.
- [ ] Add picker between authentication and negotiation, and controlled switch flow
  that releases input and retires the old peer before requesting another stream.
- [ ] Maintain aspect ratio and reject pointer positions outside displayed content.
  Label session audio as system output, not audio from a particular monitor.
- [ ] Verify real two-monitor capture/input, hot unplug and restart, desktop and
  iPhone playback, then update documentation with actual completed scope.

The current roadmap's milestone 2 is multiple sessions and multiple streams;
no inactive advanced controls should imply working stream negotiation.

## Foundation checkpoint

Implemented native `--list-displays` and probe inventory, pure coordinate-mapping
tests, and inventory-backed native monitor map/expandable rows via the owned ready
message. Runtime input/capture still use the existing primary-only behavior: the
new coordinate helper is not wired to input yet. No sharing switches are presented
as functional. Policy persistence, hotplug refresh, Identify, capture target binding
and browser selection remain required before the full vertical slice is complete.

Real inventory on the development PC reports one 2560 × 1440 primary monitor at
144 Hz. Two-monitor layout tests use explicit landscape/portrait fixtures, not a
claim of real secondary-monitor capture acceptance.

## Implementation checkpoint: approved flat settings

The earlier foundation checkpoint is superseded by this implementation slice:

- Persisted display sharing by stable identity; legacy policy seeds only the current
  persistent primary display once. Newly attached displays are not automatically shared.
- Authenticated catalog and reconnect carry the selected display and inventory revision.
  Per-display default profiles resolve before worker startup. Denied changes preserve
  the old session; topology changes during teardown cannot start a stale replacement.
- Worker resolves the authorized identity to HMONITOR, checks source bounds/rotation,
  and maps input into the selected display using virtual-desktop coordinates.
- Server polls inventory; worker rechecks its target and releases input on changes.
  Inventory probes are abortable during server shutdown.
- Host implements the approved flat Default profile/Allowed profiles detail rows,
  flat Host defaults, sharing switches, and draft Apply/Cancel. Per-display allowed
  profile restrictions remain disabled. Browser chips switch the selected display
  while retaining the requested profile; session summaries identify the source.
- Verified: 80 Node tests, four native CTest cases, Debug worker build, host build,
  WinUI navigation/layout regression, and browser-generated WebRTC switching test.

At that checkpoint, Identify and real hardware acceptance were still required.
Current polling conservatively disconnects on any inventory change; authentication
must be repeated after a revocation. Milestones 2–4 are not implemented by this slice.

User follow-up: tested the current implementation on iPhone. This records user-run
iPhone acceptance, not verification of every multi-monitor/input or hot-unplug case.

## Milestone 1 acceptance — 2026-09-14

This status supersedes the historical checkpoints and unchecked planning list above.

- User explicitly confirmed that capture and pointer input on both monitors,
  unplug/reconnect and a server restart all passed; iPhone acceptance was previously
  confirmed. These are user-run hardware checks, not agent-run hardware tests.
- Approved Identify design implemented: compact numbered labels at each known
  monitor's bottom-left work area, three-second expiry, no activation or taskbar
  entry, no capture dependency or OS display configuration changes. Repeated calls,
  inventory updates, stopped sharing and host exit clean up owned overlays.
- Diagnostics now distinguishes the physical source display from encoded output
  dimensions; stale measurements label it as the last selected source.
- Fresh acceptance checks: 83 portable Node tests; host build with zero warnings
  and errors; isolated native navigation/UI regression including real-monitor
  Identify positioning, nonactivation, expiry, replacement and inventory cleanup;
  synthetic browser WebRTC regression including diagnostics source/stale rendering.
- Native worker build and four CTest cases passed at the earlier implementation
  checkpoint. This completion changes no native worker code.

Milestone 1 is complete. Per-display allowed-profile filtering remains disabled;
multiple concurrent sessions/streams, input leases and adaptive quality are not
claimed by this milestone. No changes were made to the user's running capture
session or physical monitor configuration during these completion checks.
