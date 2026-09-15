# Multiple Sessions Implementation Plan

> Execute inline with superpowers:executing-plans, without subagents, in the
> user-approved feature checkout. Commit only at the milestone acceptance gate.

**Goal:** Independent concurrent sessions, then concurrent display streams per device.

**Architecture:** Explicit session ownership, bounded stream registry, isolated
worker lifetimes and diagnostics; native-enforced exclusive control leases.

**Tech Stack:** Node ESM, C++/GStreamer/Win32, browser JS, WinUI 3/C#.

**Spec:** `docs/superpowers/specs/2026-09-14-multi-session-design.md`

## Constraints

Preserve Windows 11/NVIDIA and iPhone baselines. No new dependencies, encoder
sharing or quality reductions. Two sessions, two video streams per device, four video
workers plus at most one audio-only worker per device (six processes maximum).
No network administration endpoint. No milestone commit while
acceptance remains incomplete. Do not terminate the user's existing host.

## 1. Concurrent session admission and worker ownership

Files: `apps/server/src/session-store.mjs`, `native-media.mjs`, `http-app.mjs`;
colocated `tests/session-lifecycle.test.mjs`, `native-media.test.mjs`,
`multi-session.test.mjs`. Extract process lifecycle behind constructor injection
only at the actual process spawn boundary, so tests run real child fixtures.

- [x] RED: configured capacity admits two distinct bearer sessions; third is busy;
  disconnect/expiry frees only that owner's slot.
- [x] GREEN: store validates `maxSessions`; default remains one until integration.
- [x] RED: real fixture workers receive independent offers; stopping one cannot
  affect another; shutdown awaits both exits; duplicate IDs cannot replace a worker.
- [x] GREEN: replace `active` with bounded worker map, preserving the single-worker
  compatibility accessor until callers migrate. Reserve before startup and release
  after close. `stop(id)` is idempotent and `shutdown()` awaits every close.
- [x] RED/GREEN: HTTP reconnect and telemetry rate gates are per owner. A rejected
  admission or negotiation never disconnects an unrelated authenticated client.

Example admission assertion:
```js
const store = new SessionStore({ maxSessions: 2 });
const a = store.connect(store.password, 'a');
const b = store.connect(store.password, 'b');
assert.equal(b.ok, true);
assert.equal(store.connect(store.password, 'c').reason, 'busy');
store.disconnect(a.sessionId);
assert.ok(store.get(b.sessionId));
```
Run `node --test apps/server/tests/session-lifecycle.test.mjs` then `npm.cmd test`.

## 2. Stream registry, plans and per-stream diagnostics

Create `apps/server/src/stream-registry.mjs` and colocated tests. Registry operations
`reserve(sessionId, plan)`, `get(sessionId, streamId)`, `release(streamId)` enforce
ownership and count/bitrate/pixel budgets before async work. Store the negotiated
profile/source/audio role with each stream. IDs use UUIDs; bearer credentials never
become public stream identifiers.

- [x] RED: cross-owner lookup fails; pending/closing streams consume capacity;
  failed reservation leaves previous streams intact; budgets count every stream.
- [x] GREEN: implement reservations and explicit lifecycle transitions.
- [x] RED/GREEN: own Diagnostics per stream; reconnect resets only that history;
  client telemetry targets authorized stream IDs and has independent rate limits.
- [x] Integrate `main.mjs`, `host-status.mjs`, `http-app.mjs` and
  `policy-controller.mjs`; topology changes invalidate only affected streams.

Run registry tests, all server tests and real-child lifecycle tests.

## 3. Native input permission and audio ownership

Files: native worker input/session protocol; server owned command handling;
new pure lease tests and native tests under `native/media-worker/tests`.

- [x] RED: client data-channel enable cannot override absent/revoked permission.
- [x] GREEN: separate server permission from local input enabled; revoke always
  releases held input, then acknowledges before transfer to another worker.
- [x] RED/GREEN: expiry/disconnect/replacement releases ownership; stale acknowledgments
  cannot grant an old lease; keep only one authorized input stream host-wide.
- [x] RED/GREEN: dedicated session audio lifecycle, no duplicate audio on second
  video subscription and no audio teardown when one video stream stops.

Run pure native CTest plus worker protocol regression without injecting OS input.

## 4. Browser and host UI integration

Files: web `app.js`, `index.html`, diagnostics; native `HostWindow.Sessions.cs`,
session administration and graph layout. Approved preview remains the visual target.

- [x] RED/GREEN: two browser contexts authenticate/receive concurrently; switching,
  stopping and telemetry are isolated; subscriptions cannot address another owner.
- [x] RED/GREEN: host renders two devices/three stream graphs independently; grant,
  revoke, end-stream and disconnect commands carry correct owner/stream IDs.
- [ ] Verify compact sizes, native light/dark, existing overlay/fullscreen and
  selected-display fit. Keep target and measured FPS clearly separate.

## 5. Acceptance and milestone commit

- [ ] Run all Node tests, native build/CTest, host build/UI regression and synthetic
  multi-peer browser test; review auth, race and teardown paths against the spec.
- [ ] Verify real two-client/two-display audio/input and shutdown acceptance; record
  what the user tested versus what automation proved.
  - [x] User confirms two-monitor functionality is satisfactory for now.
  - [ ] Remaining combined audio/input, iPhone and shutdown acceptance; the
    two-monitor confirmation alone does not cover these scenarios.
- [ ] Update roadmap and commit the complete milestone, not an intermediate slice.

## Historical foundation checkpoint — 2026-09-14

Completed task 1 and the isolated registry portion of task 2. Real child-process
fixtures cover independent offers/metrics, stopping capacity, failure, shutdown,
and expected versus unexpected exits. HTTP tests exercise reconnect reservations,
concurrent admission, per-owner telemetry rate limiting, admission refusal without
revocation, and disconnect while reconnect is pending.

Task 3 foundations exist: pure native five-second permission lease, owner-pipe
grant/revoke acknowledgement, bounded pending acknowledgements in NativeMedia,
and serialized control coordinator with release acknowledgement/OS-exit fallback.
The Debug worker protocol check sends no offer, captures nothing and injects no
input. Multi-owner status derivation is tested independently too.

These are not yet the complete runtime feature. `main.mjs` still creates the
single-session/single-worker configuration; strict host control is opt-in and not
enabled by normal startup yet. Registry routing, session audio, native host actions,
browser subscriptions and diagnostic selection must be integrated before raising
that limit. Existing web UI regression still passes. No milestone 2 commit yet.

## Integration checkpoint — 2026-09-14

StreamRuntime now joins admission, per-stream worker/diagnostics ownership, topology
invalidation, control leases and session audio. Authenticated HTTP stream/audio
routes are exercised with real fixture child processes; disallowed profiles and
capacity refusal do not tear down existing streams. Host status derives each
stream's independent frame graph; local diagnostics has a stream selector and does
not disclose bearer credentials or substitute another stream when one ends.

The viewer supports the new `mode: streams` handshake while preserving legacy
startup. Its synthetic two-browser regression proves three video subscriptions,
one audio peer per device, reuse when switching back, selected-only quality
replacement, receiver telemetry, independent disconnect, diagnostics selection,
and restart of a host-ended stream. A deliberately delayed heartbeat reproduces
and guards against accidentally closing a replacement stream.

Audio-only native WebRTC has also been built and tested: no video capture or input
permission, and no video-telemetry probe warnings. The separate audio workers are
bounded independently of the four-video registry budget.

This checkpoint was subsequently committed as `a7f1ef0`. It was not milestone
completion.

## Runtime/host checkpoint — 2026-09-14

Normal startup now uses StreamRuntime (two devices, four video plus two audio
workers), periodic native permission renewal, selective topology invalidation,
policy teardown and owned shutdown. Native Sessions has stable per-stream graph
rows, Grant/Revoke and Stop commands with bounded acknowledgement waits. CLI has
local `sessions`, `grant <stream-id>`, `revoke`, and `disconnect <stream-id>` commands.

Receiver audio diagnostics remain session-level and separate from each video's
history. Switching retains each display's selected profile; delayed heartbeat
responses cannot close new peers; hotplug refreshes the display picker. Disconnect
releases input immediately and waits for server cleanup before closing transports,
with a bounded fallback. This fixes the reproduced SCTP disconnect resource error.

Verified: 104 portable tests; real synthetic two-viewer/three-video regression;
native navigation, stable graphs and owner-pipe action targets; production startup
on an isolated port/profile; Debug host/worker build and 4/4 CTests. The standalone
Debug host runtime manifest has been prepared. Native two-viewer/two-audio capture,
permission rejection/transfer/revoke and zero owned-process residue passed on one
physical monitor.

Still outstanding: investigate intermittent GStreamer startup warning in
`on_rtpbin_request_aux_receiver` with one startup timeout (subsequent unchanged run
passed); simultaneous capture of two physical monitors (only one currently
connected); real iPhone/touch/fullscreen and input-routing acceptance with this
multi-session build. Do not mark or commit the milestone complete yet.

## Access-default checkpoint — 2026-09-14

Committed implementation through `b328f93`, without marking milestone 2 complete.
The approved Access-page selector persists Require host approval / Allow when
available separately from stream settings. A session captures the default at
admission; its first stream selection can receive an automatic grant only when
control is available. No takeover, automatic retry after revoke, or change to an
existing session on save. Browser input enablement remains separate.

Latest verification: 109 portable tests passed, native navigation/owner-pipe tests
saved both choices, production startup tests confirmed no disconnect on save and
no HTTP access-settings endpoint. Standalone Debug preparation passed with zero
host build warnings/errors and 4/4 native CTests. The running user host was not
restarted. Earlier synthetic browser and native capture results remain the prior
checkpoint's evidence; no new iPhone/two-monitor acceptance is claimed here.

Next: investigate the startup warning/timeout, then complete the physical-device
acceptance above. See the roadmap's Immediate next steps; do not repeat completed
registry, session audio, lease or host-action implementation.

### Subsequent user acceptance

User confirmed: "2 monitor function is ok for now." Two-monitor functionality is
accepted for now and no longer awaits a repeat verification. This supersedes the
earlier two-monitor pending notes, without claiming a new automated run or extending
the confirmation to iPhone, combined audio/input, hotplug or shutdown scenarios.
The intermittent startup warning/timeout remains unresolved.
