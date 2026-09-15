# Shared Capture and Encode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Devices that view the same display with the same resolved profile share one capture and one NVENC encode. Devices with the same audio format share one loopback capture and one Opus encode. Clients see no protocol change.

**Architecture:** One native worker process per *source* fans out after `h264parse` / `opusenc` through a `tee` into per-viewer *peer* bins (leaky queue → payloader with per-peer SSRC → `webrtcbin`). The server splits its model into sources (worker, budgets, matching key) and subscriptions (one per client stream, owning diagnostics, recovery and control target). `NativeMedia` speaks the new worker protocol and keeps a compatibility `offer` for the legacy runtime-less route.

**Tech Stack:** C++17, GStreamer 1.28 (`tee`, `webrtcbin`, `nvd3d11h264enc`, `wasapisrc`, `opusenc`), json-glib, CMake/CTest; Node ESM with `node --test`; WinUI 3 C#; Playwright for hardware checks.

**Spec:** `docs/superpowers/specs/2026-09-15-shared-streams-design.md`. The spec holds the pipeline strings, protocol tables, failure table and rationale. Read it before any task; this plan doesn't repeat it.

**Style of this plan:** tasks give files, interfaces, required behaviour, test cases and commands. Implementers write the code, following the surrounding code's idiom.

## Global Constraints

- Video matching key: `video|<revision>|<display id>|<x>,<y>,<width>,<height>,<rotation>|<width>x<height>@<fps>|<bitrateKbps>`. Profile names and ids never participate.
- Audio matching key: `audio|mono-32k` or `audio|stereo-96k`. The format comes from the session profile: `fps === 15` → `mono-32k`, otherwise `stereo-96k`.
- Host budgets count video **sources** in `starting`/`ready`/`closing`: `maxStreams` 8, `bitrateKbps` 32 000, `pixelsPerSecond` 500 000 000. `perSession` 2 counts video **subscriptions**. Joining an existing source costs nothing. Refusals stay HTTP 409 with the existing messages.
- Production `NativeMedia.maxWorkers` is 12.
- Worker limits: command ≤ 131 072 bytes; SDP ≤ 65 536; `peerId` 1–64 characters; `leaseMs` 1–5000.
- SSRC per worker: video `10000001 + 2 × peer index`, audio `20000001 + 2 × peer index`, on both the payloader and the caps.
- Timings:
  - peer negotiation 15 s
  - `remove-peer` acknowledgement 1.5 s (a timeout stops the source)
  - control acknowledgement 1.5 s; renew every 2 s; worker lease 5 s
  - recovery keyframe ≤ 1 per 2 s per source; join keyframes coalesce within 500 ms
  - input limit 1000 messages/s and 256 pending messages, **per peer**
- Client-visible stream states stay `starting` → `live` → `closing`. The spec's `negotiating` is `starting`, so `/api/streams` and `/api/heartbeat` don't change.
- Run only the test files a task touches. Never truncate failing-test lists. `build-native.cmd` formats native code, builds and runs CTest.
- **Commits:** each task ends with a commit step. Run it only when the user has authorised commits for this execution.

## Deviations from the spec (decided while planning)

1. **Join keyframe timing.** `webrtcbin` drops RTP until DTLS connects, so the worker requests the join keyframe when a peer's `connection-state` becomes `connected`, not at answer time. It is still coalesced within 500 ms, with the 1 s GOP as fallback.
2. **No worker-side peer queue.** `start` runs synchronously on the GLib main loop and emits `ready` before the next command is read. An `add-peer` following `start` in the pipe is therefore always handled after `ready`. `add-peer` before `start` fails the peer.
3. **Spike replaced by a gate.** Task 4 is a hardware check against the real refactored worker: two loopback viewers, removal, a late join and control isolation. It must pass before the server model tasks (5+) start.
4. **Combined legacy workers.** The legacy `offer(id, sdp, profile, audio, display)` needs video and audio in one worker, so `start` accepts `audioFormat` together with `video: true`, and each peer gets both branches. The runtime never sends that combination.
5. **Payload numbers validated.** SDP `pt` values are interpolated into `gst_parse` descriptions, so only 1–3 digits ≤ 127 are accepted. This closes an injection gap in the current worker.
6. **Peer-scoped element errors.** A bus `ERROR` whose source lies inside a peer bin fails only that peer. Errors from the source chain stay fatal.

## File map

| File | Responsibility |
| --- | --- |
| `native/media-worker/src/peer-permission.hpp` (new) | One permitted peer per worker, on top of `HostInputPermission` |
| `native/media-worker/src/keyframe-limiter.hpp` (new) | 500 ms join coalescing; 2 s recovery limit |
| `native/media-worker/src/sdp-payload.hpp` (new) | Offer parsing; per-peer H.264/Opus payload selection |
| `native/media-worker/src/media-worker.cpp` | Source chain + tees, peer bins, protocol, per-peer input and telemetry |
| `native/media-worker/tests/{peer-permission,keyframe-limiter,sdp-payload}.cpp` (new) | Assert-style unit tests |
| `native/media-worker/tests/shared-stream-check.mjs` (new) | Hardware gate and acceptance |
| `apps/server/src/media-sample.mjs` (new) | `peerSample(message, peerId)` |
| `apps/server/src/native-media.mjs` | Source/peer API plus compatibility `offer` |
| `apps/server/tests/fixtures/media-process.mjs` | Fake worker speaking the new protocol |
| `apps/server/src/stream-registry.mjs` | Sources and subscriptions, `sourceKey`, `audioFormat` |
| `apps/server/src/stream-runtime.mjs` | Subscription lifecycle, metrics split, per-subscription diagnostics/recovery, `viewers` |
| `apps/server/src/control-lease.mjs` | Fail closed through `removePeer` |
| `apps/server/src/main.mjs` | `maxWorkers: 12` |
| `apps/server/src/cli/format.mjs` | `Shared` column |
| `apps/windows-host/HostWindow.Sessions.cs` | `Shared · N devices` label |

No edits are needed in:
- `http-app.mjs`: the legacy route keeps using `media.offer`, `media.stop`, `media.workers.get(token)?.diagnostics` and `media.receiverFeedback`, all preserved by the compatibility layer.
- `host-status.mjs`: `viewers` is added in `StreamRuntime.status()`.
- The web client.

---

### Task 1: Native pure headers and unit tests

**Files:**
- Create: `native/media-worker/src/peer-permission.hpp`, `keyframe-limiter.hpp`, `sdp-payload.hpp`
- Create: `native/media-worker/tests/peer-permission.cpp`, `keyframe-limiter.cpp`, `sdp-payload.cpp`
- Modify: `native/media-worker/CMakeLists.txt`: extend the test `foreach` list; link `sdp-payload-test` to `gstreamer_sdk gstsdp-1.0`

**Interfaces (produced):**
- `class PeerPermission { void grant(const std::string &peer, bool known, int64 nowMs, int64 durationMs); void revoke(const std::string &peer); bool allowed(const std::string &peer, int64 nowMs) const; const std::string &permitted() const; }`
- `class KeyframeLimiter { bool join(int64 nowMs); bool recovery(int64 nowMs); }`
- `struct OfferPayloads { std::string video, audio; }`, `GstSDPMessage *parse_offer(const std::string &)` (caller frees; `nullptr` if invalid), `OfferPayloads select_payloads(const GstSDPMessage *)`, `std::string rtpmap_payload(const char *rtpmapValue)`

**Required behaviour:**
- `PeerPermission` wraps one `HostInputPermission` and one owner id:
  - `grant` always clears the current owner first.
  - An unknown peer (`known == false`) or an empty id is refused and leaves no owner.
  - An out-of-range duration grants nothing.
  - `revoke(peer)` affects only the owner.
- `KeyframeLimiter` keeps two independent timestamps. A call succeeds when `now - last >= 500` (join) or `>= 2000` (recovery). The first call always succeeds.
- `sdp-payload.hpp` moves the payload selection out of today's `start_offer` unchanged:
  - Video: an `H264/90000` rtpmap whose fmtp has `packetization-mode=1` and `profile-level-id=42e0`; the last match wins.
  - Audio: the first `opus/48000[/2]`.
  - New: `rtpmap_payload` returns the leading token only when it is 1–3 digits ≤ 127.
  - `parse_offer` keeps today's rules: size ≤ 65 536, `GST_SDP_OK`, a version present, at least one media.

- [ ] **Step 1: Write the failing tests** (the same assert style as `tests/stream-profile.cpp`)
  - `peer-permission.cpp`:
    - grant a → a allowed, b not
    - grant b → a no longer allowed
    - `revoke("a")` while b owns → b still allowed
    - revoke b → nothing permitted
    - grant b then `grant("ghost", known=false)` → nobody allowed
    - grant a at 4000 for 5000 → allowed at 8999, not at 9000
    - duration 5001 → no owner; empty id → no owner
  - `keyframe-limiter.cpp`:
    - `join(0)` true, `join(499)` false, `join(500)` true
    - `recovery(100)` true, `recovery(2099)` false, `recovery(2100)` true
    - `join(1000)` true (independent of recovery)
  - `sdp-payload.cpp` (call `gst_init` first):
    - a video offer with VP8 96, H264 98 (`packetization-mode=0`) and H264 102 (`packetization-mode=1;profile-level-id=42e01f`) → video `"102"`, audio empty
    - an audio offer `111 opus/48000/2` → audio `"111"`
    - `profile-level-id=42001f` → video empty
    - `a=rtpmap:96!fakesink H264/90000` (with a matching fmtp) → video empty
    - `rtpmap_payload("128 opus/48000/2")`, `("111")` and `(nullptr)` → empty
    - `parse_offer("invalid")` and a 65 537-byte string → `nullptr`
- [ ] **Step 2: Verify failure.** Run `.\build-native.cmd`. Expected: the compile fails on the missing headers.
- [ ] **Step 3: Implement the three headers** to the behaviour above. Reference code: Appendix A.
- [ ] **Step 4: Verify.** Run `.\build-native.cmd`. Expected: 7 CTest tests pass (4 existing + 3 new).
- [ ] **Step 5: Commit** `feat(native): add peer permission, keyframe limiter and SDP payload helpers`

---

### Task 2: Native worker source/peer refactor

**Files:**
- Modify: `native/media-worker/src/media-worker.cpp`
- Modify: `native/media-worker/tests/native-worker.test.mjs` (session case)
- Modify: `native/media-worker/tests/control-permission-check.mjs`

**Interfaces (produced, consumed by Tasks 3–4):**

The worker protocol is exactly the spec's "Protocol" table, with these precisions:
- `start`:
  - `{ video: bool, hostControl: bool, streamPlan?, profile?, display?, audioFormat? }`
  - `video` must be a JSON boolean; a missing value is false.
  - `video: false` requires `audioFormat`; `video: true` may also carry `audioFormat` (legacy combined worker, deviation 4).
  - `streamPlan`/`profile` are parsed by the existing `set_profile`; `display` by the existing `set_display`.
  - A second `start`, an invalid format, profile or display → fatal.
- `add-peer` failures emit `peer-failed` with one of these `reason` strings:
  - `"Source not started."`
  - `"Duplicate peer."`
  - `"Invalid SDP"`
  - `"Browser must offer constrained-baseline H.264 with packetization-mode=1."`
  - `"Browser must offer Opus audio."`
  - `"WebRTC connection failed."`
  - `"Unable to create WebRTC answer."`
  - or a GStreamer error message
- An invalid `peerId` on `add-peer`/`remove-peer` → fatal `Invalid command`. An invalid `control-permission` stays fatal.
- `control-permission` answers `allowed: true` only for a known, non-removing peer on a video worker. Revoking a non-owner is a no-op that still answers.
- `keyframe` before `start` or on an audio worker is ignored (today it is fatal).
- `metrics` is emitted each second only while peers exist. The top level carries today's fields except the transport fields, which move under `peers[peerId]`:
  - `videoRtp*`, `iceInput*`
  - `rtxSenders`, `rtxRequests`, `rtxPackets`
  - `queueMaxBytesSampled`, `queueMaxMsSampled`

**Required behaviour:**

- **Global state.** Remove the single-connection globals:
  - `peer`, `answered`, `audio_enabled`, `control`, `last_ping`, `pending_input`
  - `input_channel`, `host_input_permission`, `transport_telemetry`, `last_recovery`

  Add:
  - `started`, `playing`, `audio_channels` (0/1/2)
  - `PeerPermission peer_permission`, `KeyframeLimiter keyframe_limiter`
  - `std::map<std::string, std::unique_ptr<Peer>> peers`, `next_peer_index`

  `Peer` holds: id, index, owned `bin` ref, borrowed `webrtc`, owned video/audio tee request pads, owned `input_channel` ref, `answered`/`removing`/`notify_closed`, `pending_unlinks`, `control`, `last_ping`, rate window/count, `std::shared_ptr<std::atomic<int>> pending_input`, and its own `TransportTelemetry`.
- **Thread safety (the main risk in this task).**
  - GStreamer-thread callbacks (promises, `notify::*`, data channel signals, pad probes) never dereference a `Peer`. They carry a heap-allocated `PeerRef { id, index, pending_input }`, passed via `g_signal_connect_data` / `gst_promise_new_with_change_func` with destroy notifies, and marshal to the main loop.
  - On the main loop, the peer is looked up by id **and** index; a missing or `removing` peer means the callback is ignored.
  - Copy the ref before `gst_promise_unref` inside a change func, because unref can free the notify data.
  - All pipeline mutation happens on the main loop.
- **Source chain.**
  - `start` builds the pipeline with `gst_parse_launch`: `pipeline_description() + " ! tee name=video-fanout allow-not-linked=true"` and/or the spec's audio chain ending in `tee name=audio-fanout allow-not-linked=true`, keeping element names `audio-capture` / `audio-encoder`.
  - Attach `telemetry` + `attach_recovery` (video) and `audio_telemetry` plus the bus watch.
  - Emit `ready` with the pipeline still in NULL. `playing` becomes true (pipeline → PLAYING) when the first peer is linked.
  - `--self-test` keeps using `pipeline_description(60)` unchanged.
- **Add peer**, in this order:
  1. Validate the offer and payloads (Task 1).
  2. Build `GstBin "peer-<index>"` (ref-sunk) and attach its `TransportTelemetry` to that bin.
  3. Add `webrtcbin` (max-bundle, latency 0, `do-nack` on new transceivers).
  4. For each kind, `gst_parse_bin_from_description(branch, TRUE)` with the spec's per-peer branch plus a trailing `identity name=video-output` (or `audio-output`) so transport telemetry finds it. Link the branch to `webrtc`, video first. Ghost its sink pad as `video_sink`/`audio_sink` on the peer bin.
  5. Connect `notify::ice-gathering-state`, `notify::connection-state` and `on-data-channel`.
  6. Insert into `peers`.
  7. Add the bin to the pipeline; if `playing`, `gst_element_sync_state_with_parent` **before** linking.
  8. Request tee pads (`gst_element_request_pad_simple(tee, "src_%u")`) and link them to the ghost pads.
  9. If not yet playing, set the pipeline to PLAYING.
  10. `set-remote-description` → (main loop) `create-answer` → (main loop) `set-local-description`, then `send_answer`. The answer is emitted when gathering is complete and the local description exists.

  Any failure after insertion goes through `fail_peer`.
- **Connection state.** `FAILED` → `fail_peer("WebRTC connection failed.")`. `CONNECTED` on a video worker → `request_keyframe(pipeline)` if `keyframe_limiter.join(nowMs)` (deviation 1).
- **Remove peer.**
  - An unknown id emits `peer-closed` immediately.
  - Otherwise:
    1. Set `notify_closed |= notify`; return if already removing.
    2. `peer_permission.revoke(id)` and release the peer's input, sending `{"control":false}`.
    3. Mark it removing.
    4. Add a `GST_PAD_PROBE_TYPE_IDLE` probe per tee pad. The probe unlinks, schedules the finish with **`g_idle_add_full`** (never an immediate invoke: an idle probe can fire synchronously inside `remove_peer`) and returns `GST_PAD_PROBE_REMOVE`.
    5. When the last unlink finishes: release and unref the request pads, unref the channel, set the bin to NULL, `gst_bin_remove`, unref the bin, then emit `peer-closed` if `notify_closed`.
  - A peer with no tee pads is destroyed directly.
  - `fail_peer` emits `peer-failed`, then `remove_peer(id, notify=false)`.
- **Input** (spec "Input rules"):
  - A data channel labelled `input` on a video worker is attached to its peer; all others are closed.
  - Queue the channel attach on the main loop **before** connecting `on-message-string`/`on-close`.
  - The message handler is today's `input_message`, with `control`/`last_ping`/rate window per peer.
  - "Allowed" means `!host_control_required || peer_permission.allowed(peer.id, nowMs)`.
  - When a peer gains control, every other peer with control is revoked with notification.
  - Held keys and buttons stay global; releasing them is triggered only by a peer that had control.
  - The 1 s timer revokes (with notification) any peer whose ping is older than 5 s or whose lease is gone.
  - Replace `release_input()` with `release_held()` (keys/buttons) and `revoke_peer(peer, notify)`.
- **Bus.** An error whose `message->src` has a peer bin as an ancestor → `fail_peer`; otherwise fatal (deviation 6).
- **Teardown.** Set the pipeline to NULL, then unref each peer's pads, channel and bin, then the pipeline.
- **Unchanged:** preflight, `--probe`, `--list-displays`, `--self-test*`, capture display watchdog (fatal), stdin reader, 5 s shutdown deadline.

- [ ] **Step 1: Update the native session tests (failing first)**
  - `native-worker.test.mjs`: the `--session` helper writes `start` (`video:false, audioFormat:"mono-32k", hostControl:true`), then `add-peer` (`peerId:"invalid", sdp:"invalid"`), then ends stdin. Rename the case to *"native session fails a malformed peer without failing its source or starting capture"* and assert exit code 0 with stdout lines exactly `[{type:'ready'}, {type:'peer-failed', peerId:'invalid', reason:'Invalid SDP'}]`.
  - `control-permission-check.mjs`: `start` an audio worker and await `ready`. Then `control-permission` for `peerId:"absent"` with `(1, true)` and `(2, false)`, each answering `allowed:false`. Then `stop` → exit 0. Rename to *"native owner pipe refuses control for unknown peers and acknowledges before clean shutdown"*. Granting a real peer is covered by Task 4.
- [ ] **Step 2: Verify failure.** Run `.\build-native.cmd`, then `node --test native/media-worker/tests/native-worker.test.mjs native/media-worker/tests/control-permission-check.mjs`. Expected: the session case and the control check fail (`start` is an invalid command today); probe and self-tests pass.
- [ ] **Step 3: Implement the refactor** to the behaviour above. Reference code (uncompiled draft): Appendix B.
- [ ] **Step 4: Verify.** Run `.\build-native.cmd` (no new `/W4` warnings; CTest passes), then the same `node --test` command. Expected: 5 tests pass.
- [ ] **Step 5: Commit** `feat(native): fan one capture/encode out to per-peer webrtcbin branches`

---

### Task 3: `NativeMedia` source/peer API and protocol fixture

**Files:**
- Create: `apps/server/src/media-sample.mjs`
- Modify: `apps/server/src/native-media.mjs`
- Modify: `apps/server/tests/fixtures/media-process.mjs`
- Modify: `apps/server/tests/media-lifecycle.test.mjs`
- Modify: `native/media-worker/tests/audio-only-check.mjs` (`setPermission` call only)

**Interfaces:**
- Consumes: the Task 2 worker protocol.
- Produces:
  - `peerSample(message, peerId)` → `{ ...message without peers, ...message.peers?.[peerId] }` (in `media-sample.mjs`; no native imports, so the web-client checks can import it).
  - `new NativeMedia({ onExit, onMetrics, onPeerFailed, diagnostics, maxWorkers = 1, hostControl = false, negotiationTimeoutMs = 15000, removalTimeoutMs = 1500, launch })`. The callbacks are public properties the runtime may wrap: `onExit(sourceId, { expected })`, `onMetrics(sourceId, message)`, `onPeerFailed(sourceId, peerId, reason)`.
  - `start(sourceId, { video, profile?, display?, audioFormat? })` → `Promise<void>`. Resolves on `ready`; rejects on exit before ready. It rejects synchronously-returned `MEDIA_BUSY` for a duplicate id or `maxWorkers`, exactly as `offer` does today. The worker record is created synchronously.
  - `addPeer(sourceId, peerId, sdp)` → `Promise<string>` (answer SDP)
  - `removePeer(sourceId, peerId)` → `Promise<void>` (idempotent per peer)
  - `stop(sourceId)` (unchanged)
  - `shutdown()` (unchanged)
  - `setPermission(sourceId, peerId, allowed)` → `Promise<boolean>`
  - `keyframe(sourceId)` → `boolean` (true if sent)
  - `offer(id, sdp, profile, audio, display, { video })` → `Promise<string>` (compatibility)
  - `receiverFeedback(id, sample)` (compatibility workers only)
  - `active` getter (unchanged)
  - `workers: Map<sourceId, record>`. A record keeps `id`, `video`, `child`, `stderr`, `stopping`, `closed`, `peers: Map<peerId, entry>`, `permission`, `lastKeyframeAt`. Compatibility workers also keep `diagnostics` and `recovery`.

**Required behaviour:**
- **`start`** writes `{ type:'start', video, hostControl, streamPlan (when profile.width is defined, mtu 1200), profile: profile.name || 'desktop' (video only), display, audioFormat }`.
- **Line routing:**
  - `ready` resolves start.
  - `answer{peerId}` resolves that negotiating peer (clear its timer, state `live`).
  - `peer-failed`:
    - negotiating peer → reject with `new Error(reason)` and delete the entry
    - live peer → delete, then `onPeerFailed` (compatibility workers instead `stop` the worker, preserving legacy single-peer semantics)
    - removing peer → ignore; the pending removal completes on `peer-closed`
  - `peer-closed` resolves a pending removal and deletes the entry.
  - `metrics` → `onMetrics`; compatibility workers also record `peerSample(message, id)` into their own `diagnostics`.
  - `control-result`: unchanged.
- **Negotiation timeout** (`negotiationTimeoutMs`): reject with `WebRTC negotiation timed out.`, then `removePeer`.
- **`removePeer`:**
  - Unknown worker → resolve.
  - Worker stopping → resolve on `closed`.
  - A second call returns the same promise.
  - A negotiating peer is rejected (`Peer removed`).
  - Otherwise it writes `remove-peer` even for unknown ids.
  - After `removalTimeoutMs` with no `peer-closed`, call `stop(sourceId)` and resolve after exit.
- **Exit:**
  - reject start and every negotiating peer with stderr or `Native media worker stopped.`
  - resolve every pending removal
  - reject the pending permission, delete the record, resolve `closed`
  - `onExit` exactly once
- **`setPermission`:** today's checks and 1.5 s timeout, plus `peerId` in the command. One pending change per worker.
- **`keyframe`:** false if the worker is missing, stopping or its stdin is not writable, or if less than 2000 ms passed since the last sent keyframe for this source; otherwise write `{"type":"keyframe"}` and return true.
- **Compatibility `offer`:**
  - `audioFormat` is `mono-32k` when `profile.fps === 15`, otherwise `stereo-96k`, and is omitted when `audio.mode === 'off'`.
  - Call `start`. If a *new* record appeared, attach `diagnostics` (the constructor's shared `diagnostics` when `maxWorkers === 1`, as today, otherwise `new Diagnostics()`), call `diagnostics.startStream(profile, audio, display)`, and attach a `Recovery`.
  - Then `addPeer(id, id, sdp)`.
  - On any failure, `await this.stop(id)` before rethrowing (the legacy tests rely on the slot being free when the rejection arrives).
- **`receiverFeedback(id, sample)`:** only for records with `recovery`; on a trip, call `keyframe(id)`.
- **Fixture (`media-process.mjs`)**, a fake worker speaking the new protocol:
  - `start`: exit 2 if already started or `display?.id === 'fail'`; otherwise remember it and emit `ready`.
  - `add-peer`:
    - not started, duplicate id, or `sdp === 'fail'` → `peer-failed` (`Invalid SDP`)
    - `sdp === 'crash'` → exit 2
    - otherwise store the peer; if the SDP contains `hang`, send nothing more
    - otherwise emit `metrics { captureFps: streamPlan?.fps ?? 0, peers: { [peerId]: { videoRtpPackets: <peer count> } } }`, then `answer { peerId, sdp: 'answer:' + sdp }`
  - `remove-peer`: ignore if the peer's SDP contains `no-remove`; otherwise delete it and emit `peer-closed`.
  - `fail-peer` (test-only injection): delete the peer and emit `peer-failed` (`WebRTC connection failed.`).
  - `control-permission`: ignore when `allowed === false` and the peer's SDP contains `no-revoke`; otherwise answer `allowed: message.allowed && started.video && peers.has(peerId)`.
  - `stop`: exit 0 after 100 ms.

- [ ] **Step 1: Rewrite `media-lifecycle.test.mjs` worker tests (failing first).** Keep the three `SessionStore` tests. Replace the four `NativeMedia` tests with:
  1. *intentional worker replacement does not revoke its reserved authenticated session*: as today, but the failing offer uses `'crash'` (an unexpected exit disconnects; `'fail'` is now a clean peer failure).
  2. *sources negotiate peers independently, share metrics and keep capacity until exit*:
     - `start('a', {video:true, profile:profile(15)})` and `start('b', …profile(30))` with `maxWorkers: 2`
     - `addPeer('a','p1','x')` → `'answer:x'`; `addPeer('a','p2','y')` → `'answer:y'`
     - `media.workers.size === 1` for source a
     - `onMetrics` received `peers.p2.videoRtpPackets === 2`
     - `addPeer('a','p1','z')` rejects `MEDIA_BUSY`; `start('c')` rejects `MEDIA_BUSY`
     - `stop('a')` returns the same promise twice; `start('c')` still rejects before exit and resolves after
  3. *peer failure, negotiation timeout and removal*:
     - `addPeer(..., 'fail')` rejects `/Invalid SDP/` and the worker stays alive
     - with `negotiationTimeoutMs: 100`, `'hang'` rejects `/timed out/` and a later `removePeer` resolves
     - `removePeer` of a live peer resolves and deletes the entry
     - `removePeer` twice returns the same promise
     - writing `fail-peer` for a live peer calls `onPeerFailed(source, peer, 'WebRTC connection failed.')`
  4. *unacknowledged removal stops the source*: `removalTimeoutMs: 100`; a `'no-remove'` peer; `removePeer` resolves only after the worker exited (`workers.has` false, `child.exitCode` 0).
  5. *owner permission commands address one peer*: two peers on one video source → `setPermission(s,'p1',true)` true, `(s,'p1',false)` false, `(s,'absent',true)` false; an audio source (`video:false, audioFormat:'mono-32k'`) answers false; `setPermission('absent', …)` rejects `/inactive/i`.
  6. *keyframes are limited per source*: `keyframe(s)` true, then false immediately; a different source → true.
  7. *compatibility offer*: `offer('legacy','x',profile(15))` → `'answer:x'`, `workers.get('legacy').diagnostics.snapshot().server.captureFps === 15`, `offer('legacy2','fail',…)` rejects and `workers.has('legacy2')` is false once it rejects.
- [ ] **Step 2: Verify failure.** Run `node --test apps/server/tests/media-lifecycle.test.mjs`. Expected: the new tests fail (`start is not a function`); the session tests pass.
- [ ] **Step 3: Implement** `media-sample.mjs`, the fixture and `native-media.mjs` to the behaviour above. In `native/media-worker/tests/audio-only-check.mjs`, change `media.setPermission('audio-test', true)` to `media.setPermission('audio-test', 'audio-test', true)`.
- [ ] **Step 4: Verify.** Run `node --test apps/server/tests/media-lifecycle.test.mjs apps/server/tests/multi-session.test.mjs apps/server/tests/recovery-http.test.mjs`. Expected: all pass (the latter two exercise the legacy route through fakes and must stay green). `stream-runtime`/`stream-http` tests fail until Task 6; don't run them here.
- [ ] **Step 5: Commit** `feat(server): drive native workers as shared sources with per-peer negotiation`

---

### Task 4: Hardware gate: shared stream check

Runs on the Windows/NVIDIA machine against the refactored worker. **Don't start Task 5 until this passes.** If it fails, fix the worker (Task 2) first. It covers spec risks 1–5.

**Files:**
- Create: `native/media-worker/tests/shared-stream-check.mjs`

**Interfaces:**
- Consumes: `NativeMedia` (`start`, `addPeer`, `removePeer`, `setPermission`, `onMetrics`, `workers`, `shutdown`) and `probe()`.
- Invoked like its siblings: `node native/media-worker/tests/shared-stream-check.mjs <path-to-playwright>`.

**Required behaviour** (style of `audio-only-check.mjs`: top-level script, `finally` shuts everything down, prints `PASS: …`):
1. Pick the primary persistent display from `probe().displays`. `new NativeMedia({ maxWorkers: 2, hostControl: true })`. `start('shared', { video: true, profile: { name: 'balanced', width: 1280, height: 720, fps: 30, bitrateKbps: 4000 }, display })`.
2. A `viewer(peerId)` helper opens a Playwright page and builds a raw `RTCPeerConnection`:
   - a `recvonly` video transceiver
   - a data channel labelled `input` whose messages set `window.lastControl` from `{control}`
   - `ontrack` → a muted autoplay `<video>`

   It waits for ICE gathering, calls `media.addPeer('shared', peerId, offer)` and applies the answer. It returns the milliseconds from applying the answer until `getVideoPlaybackQuality().totalVideoFrames > 0`.
3. Viewers `a` and `b` connect. After 1.5 s, assert `media.workers.size === 1`, both decoded > 30 frames, and the latest `onMetrics` message has `peers.a` and `peers.b` with `videoRtpPackets > 0` (risk 3: both routed to their tracks).
4. `removePeer('shared','b')` resolves. After 1 s, `a`'s decoded count grew by ≥ 20 (risk 4).
5. Viewer `c` joins mid-stream; its first decoded frame arrives in < 1000 ms (risk 2 and the join keyframe).
6. `setPermission('shared','a',true)` → true. `a` sends `{type:'control', enabled:true}` → `lastControl === true`. `c` sends the same → `lastControl === false`. `setPermission('shared','a',false)` → false and `a` receives `lastControl === false`. No OS input is sent.
7. Record `encodedKeyframes` before and after step 5 and print both (evidence for risk 1). Assert it increased.
8. `shutdown()` → `workers.size === 0`, the child exited, and the worker's stderr is empty.

- [ ] **Step 1: Write the check.**
- [ ] **Step 2: Build and run.** `.\build-native.cmd`, then `node native/media-worker/tests/shared-stream-check.mjs <playwright path>`. Expected: `PASS: one capture/encode served three peers with isolated removal, <1 s late join and per-peer control`.
- [ ] **Step 3: Also rerun** `node native/media-worker/tests/audio-only-check.mjs <playwright path>` (compatibility offer, audio-only worker). Expected: PASS.
- [ ] **Step 4: Commit** `test(native): add shared stream hardware check`

---

### Task 5: `StreamRegistry` sources and subscriptions

**Files:**
- Modify: `apps/server/src/stream-registry.mjs`
- Modify: `apps/server/tests/stream-registry.test.mjs` (rewrite)

**Interfaces (produced, used by Task 6):**
- `export function audioFormat(profile)` → `'mono-32k' | 'stereo-96k'`
- `export function sourceKey(plan)`: builds the keys from Global Constraints. An audio plan is `{ kind: 'audio', format }`; a video plan is today's `{ profile, display, revision, audio }`.
- `class StreamRegistry` (constructor and `limits` unchanged):
  - `subscribe(sessionId, plan)` → `{ stream, source, created }`
  - `unsubscribe(streamId)` → `{ source: Source | null, last: boolean }`
  - `markReady(sourceId)` → `boolean` (`starting` → `ready`)
  - `closeSource(sourceId)` → `boolean`: the source and its subscriptions become `closing`
  - `releaseSource(sourceId)` → `boolean`: deletes the source and its remaining subscriptions
  - `source(sourceId)` → `Source | null`
  - `sourceOf(streamId)` → `Source | null`
  - `sources()` → `Source[]`
  - `subscription(streamId)` → `Subscription | null` (unscoped, runtime use only)
  - `get(sessionId, streamId)` → video subscription or null (as today)
  - `list(sessionId?, kind = 'video')` → `Subscription[]`
  - `transition(sessionId, streamId, state)`: today's rules, applied to subscriptions of either kind
- Records (always returned as `structuredClone` copies):
  - `Source { id, kind, key, plan, pixels, state: 'starting'|'ready'|'closing', subscriptions: string[] }`
  - `Subscription { id, sessionId, sourceId, kind, state: 'starting'|'live'|'closing', plan }`. `plan` is the subscriber's own plan, so profile names stay per client.
- `release(id)` and `reserve(sessionId, plan)` are removed.

**Required behaviour:**
- `subscribe`:
  1. Validate the owner and plan as today; audio plans need a valid format.
  2. Audio: refuse a second audio subscription for the session (`Session audio already active`).
  3. Video: refuse when the session already has `perSession` video subscriptions (`Stream capacity limit reached`).
  4. Look for a source with the same key in `starting`/`ready`; join it with `created: false` and no budget cost.
  5. Otherwise, for video only, check the budgets over **all** video sources, closing included: count (`Stream capacity limit reached`), then bitrate (`Host bitrate budget exceeded`), then pixels (`Host pixel-rate budget exceeded`).
  6. Create the source (`starting`) and a subscription (`starting`).
- `unsubscribe` removes the subscription. When the source then has none left, it becomes `closing`; `last` is true only if this call caused that.
- Budgets are released only by `releaseSource`.

- [ ] **Step 1: Rewrite the registry tests (failing first).**
  - Keep *default host stream budget fits the GPU encoder session limit*.
  - *equal keys share one source; profile names don't participate*: alice and bob subscribe the same display/profile, bob's profile named differently → one source, `created` true then false, two subscriptions, `get` scoped per owner, returned copies isolated from mutation.
  - *each differing key field creates a new source*: vary revision, display id, x, rotation, width, fps and bitrate one at a time → distinct sources.
  - *host budgets count sources, per-session limit counts subscriptions*: `maxStreams: 2, perSession: 2`; four sessions join one source without error; a third session's second and third distinct keys hit `maxStreams` only on the second new source; a session with 2 subscriptions is refused even for an existing key.
  - *a closing source is never joined and keeps its budget until released*: unsubscribe the last viewer → `last` true, source `closing`; the same key creates a new source; with `maxStreams: 1` the new source is refused until `releaseSource`.
  - *audio subscriptions share per format and allow one per session*: two mono sessions → one source; a stereo session → a second source; a second audio subscribe for the same session throws `/audio/`; `list(id)` excludes audio and `list(id, 'audio')` returns it; audio never counts against video budgets.
  - *aggregate bitrate and pixel budgets reject oversubscription*: today's cases, expressed with `subscribe` and distinct displays.
  - *`releaseSource` drops remaining subscriptions*: after `closeSource` + `releaseSource`, `get` returns null and `sources()` is empty.
- [ ] **Step 2: Verify failure.** Run `node --test apps/server/tests/stream-registry.test.mjs`. Expected: the new cases fail (`subscribe is not a function`).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Verify.** Run the same command. Expected: all pass.
- [ ] **Step 5: Commit** `feat(server): track shared sources and per-client subscriptions in the stream registry`

---

### Task 6: `StreamRuntime` sharing lifecycle and per-peer control

**Files:**
- Modify: `apps/server/src/stream-runtime.mjs`
- Modify: `apps/server/src/control-lease.mjs`
- Modify: `apps/server/tests/stream-runtime.test.mjs`
- Modify: `apps/server/tests/control-lease.test.mjs`
- Modify: `apps/server/tests/stream-http.test.mjs` (only if an assertion breaks; see Step 4)

**Interfaces:**
- Consumes:
  - Task 3: `NativeMedia.start/addPeer/removePeer/stop/setPermission/keyframe`, `onExit/onMetrics/onPeerFailed`, `peerSample`, `negotiationTimeoutMs`, `removalTimeoutMs`.
  - Task 5: the full registry API, `audioFormat`.
- Produces:
  - `runtime.streamDiagnostics: Map<streamId, Diagnostics>`
  - `runtime.recoveries: Map<streamId, Recovery>`
  - `get runtime.audio`: a fresh `Map<sessionId, { id, state }>` built from `registry.list(undefined, 'audio')`. It is read-only; `http-app.mjs` and the checks only read it.
  - `status()` stream rows gain `viewers` (subscriptions on the source); session rows gain `audioViewers` (0 without audio).
  - `ControlLease({ media: { setPermission(streamId, allowed), removePeer(streamId) }, isActive })`
  - All other public runtime methods keep their signatures.

**Required behaviour** (spec "Runtime lifecycle", "Control", "Recovery", "Telemetry", "Failures"):
- **Private `#subscribe(sessionId, plan, sdp, { start, configure, valid })`:**
  1. `registry.subscribe`; errors get `status: 409`.
  2. Create the subscription's `Diagnostics` (`configure(diagnostics)` calls `startStream`) and `Recovery`.
  3. Answer = `addPeer(source.id, stream.id, sdp)`. When `created`, run it together with `media.start(source.id, start).then(() => registry.markReady(source.id))` via `Promise.all`. Joiners call `addPeer` directly (pipe ordering, deviation 2).
  4. Re-validate: session exists, not stopping, `valid()`, `registry.transition(..., 'live')`. Otherwise throw `Stream ended during negotiation`.
  5. On any error, `await #endSubscription(stream.id)`, then rethrow.
- **`offerVideo`:** validation and policy resolution unchanged.
  - `start: { video: true, profile: effective.profile, display }`
  - `configure: d => d.startStream(plan.profile, plan.audio, display)`
  - `valid: () => this.valid({ plan })`
  - The response shape is unchanged.
- **`offerAudio`:** checks unchanged and in the same order, with "already active" answered from `registry.list(sessionId, 'audio')`.
  - `plan: { kind: 'audio', format: audioFormat(session.profile) }`
  - `start: { video: false, audioFormat }`
  - `configure: d => d.startStream(session.profile, { mode: 'on' }, null)`
  - `valid: () => policy.snapshot().allowAudio`
- **Private `#endSubscription(streamId)`** (no control calls, so the lease can call it):
  1. Transition to `closing`.
  2. If the source's worker exists, `await media.removePeer(source.id, streamId)`.
  3. `registry.unsubscribe`, then `#forget(streamId)`: drop diagnostics, recovery, telemetry time and `selected` entries pointing at it.
  4. If `last`, stop the source. If its worker is already gone, call `registry.releaseSource` directly.
- **`stopStream`:** today's owner check and control revoke, then `#endSubscription`.
- **`stopSession`:** `stopStream` for each video subscription plus `#endSubscription` for its audio subscription; memoized as today.
- **`revalidate`:** for each video source not `closing` that fails `valid(source)`:
  1. If the control owner's stream is on that source, `await control.revoke(owner.sessionId)`.
  2. `registry.closeSource`, then `media.stop`. Subscriptions are released on exit.
- **`stopAll`:** covers sessions with video or audio subscriptions.
- **Media hooks** (wrap like today's `onExit`, calling any previous handler):
  - `onExit(sourceId)` → `#forget` every subscription of the source, then `registry.releaseSource`.
  - `onMetrics(sourceId, message)` → for each subscription of the source, `streamDiagnostics.get(id)?.record('server', peerSample(message, id))`.
  - `onPeerFailed(sourceId, peerId)` → `#endSubscription(peerId)`, logging errors.
- **`record`:** requires a live subscription, its diagnostics and a source. Keep the 800 ms rate limit. Record the client sample. When `recoveries.get(id).observe(sample, clock())` trips, call `media.keyframe(source.id)`.
- **`recordAudio`:** same, against the session's audio subscription.
- **`status()`/`diagnostics()`/`diagnosticStreams()`:** read `streamDiagnostics` instead of worker diagnostics; `sessionAudio` comes from the audio subscription's diagnostics.
- **Control:**
  - The lease adapter's `setPermission(streamId, allowed)` resolves `registry.sourceOf(streamId)` and calls `media.setPermission(source.id, streamId, allowed)`. Look up `media.setPermission` at call time so tests can spy on it. It rejects `Inactive control worker` without a source.
  - `removePeer(streamId)` → `#endSubscription(streamId)`.
  - `isActive` additionally requires the source to be `ready` and `media.workers.has(source.id)`.
  - In `control-lease.mjs`, both fail-closed paths (`#release` catch and `grant` catch) call `this.media.removePeer(streamId)` instead of `this.media.stop(streamId)`. Update the comment: removal acknowledgement, or source stop on timeout, is the fail-closed alternative.

- [ ] **Step 1: Update the control lease tests (failing first).** In `control-lease.test.mjs`, rename the fake `stop(id)` to `removePeer(id)` pushing `['removed', id]`, and expect `['removed', 'a']` / `['removed', 'b']` where `['stopped', …]` was expected. Rename the second test to *"failed acknowledgement removes the old peer before transfer and expired owner cannot renew"*.
- [ ] **Step 2: Rewrite runtime tests that assumed one worker per stream, and add sharing tests (failing first).** In `stream-runtime.test.mjs`:
  - `setup(t, defaultControl, approvedClients, mediaOptions = {})` spreads `mediaOptions` into `NativeMedia`. Add a `waitFor(condition, timeout = 2000)` polling helper.
  - Keep the five control/access tests as they are.
  - *runtime negotiates owner-scoped streams with separate metrics…*: replace `media.workers.get(x.streamId).diagnostics` with `runtime.streamDiagnostics.get(x.streamId)`. `first` (a, display 0, mobile) and `other` (b, display 0, mobile) now share: after `stopStream(a, first)`, assert `runtime.list(b)[0].state === 'live'` and `media.workers.size === 2`; after `stopSession(a)`, `media.workers.size === 1`.
  - *topology invalidation…*: assert through `runtime.list(a).length === 1` and `runtime.list(b).length === 0`.
  - *audio is one independent subscription per device…*: assert `runtime.audio.get(a).id === audio.streamId` instead of the worker's `video` flag. After both video stops, `runtime.audio.size === 1`; after `stopSession(a)`, `media.workers.size === 0`.
  - *host status keeps each stream graph separate…*: record server metrics through `runtime.streamDiagnostics.get(first.streamId).record('server', …)`.
  - *host grant follows selected stream…*: replace the final `media.workers.has` checks with `runtime.list(a)` ids.
  - New tests:
    - *identical display and profile subscriptions share one worker and stop it with the last viewer*: `offer(a)`, `offer(b)` → `workers.size === 1`, `registry.sources()[0].subscriptions` holds both ids, `status()` rows show `viewers === 2`; stop a → still 1 worker and b live; stop b → 0 workers and 0 sources.
    - *different profiles on one display use separate workers*: `offer(a)`, `offer(b, 0, 'balanced')` → 2 workers, `viewers === 1`.
    - *source metrics reach every viewer while peer transport stays with its subscription*: after `offer(a)` then `offer(b)`, a's latest server sample has `captureFps === 15` and `videoRtpPackets === null`; b's has `videoRtpPackets === 2`.
    - *a worker exit releases every subscription of that source only*: a and b share display 0, and a also has display 1. Kill the shared child and await its `close` → `list(a)` is only the display 1 stream, `list(b)` is empty, one source remains.
    - *a failed peer ends only its own subscription*: write `{type:'fail-peer', peerId: second.streamId}` to the shared child → `waitFor(list(b) empty)`; a stays live; 1 worker.
    - *negotiation timeout removes the peer and stops a source without viewers*: `mediaOptions { negotiationTimeoutMs: 200 }`; a live on display 0; b's `v=0 hang` offer rejects `/timed out/` → b has no streams and there is 1 worker; stop a; b's `v=0 hang` again → 0 workers once it rejects.
    - *control transfers between two viewers of one source and addresses each peer*: spy on `media.setPermission`; grant a then b → calls `[[first,true],[first,false],[second,true]]`; owner is b.
    - *an unacknowledged revoke removes only that peer*: b offers `v=0 no-revoke`; grant b; `control.revoke(b)` → owner null, `list(b)` empty, a live, 1 worker.
    - *an unacknowledged removal stops the whole source*: `mediaOptions { removalTimeoutMs: 200 }`; b offers `v=0 no-revoke no-remove`; grant then revoke b → `list(a)` empty and 0 workers.
    - *recovery trips from two viewers produce one shared keyframe per two seconds*: spy on `media.keyframe`; record `{pliCount:0}` for both, clear `runtime.telemetryTimes`, record `{pliCount:1}` for both → spy results `[true, false]`.
    - *audio subscriptions share one worker per format*: `offerAudio(a)`, `offerAudio(b)` (both mobile) → 1 worker, `runtime.audio.size === 2`, `status()` session rows `audioViewers === 2`; disconnect b and connect a fresh session with a 30 fps profile, then `offerAudio` → 2 workers.
    - *budget refusals happen only when a new source is required*: `new StreamRegistry({ maxStreams: 1 })` injected through the `StreamRuntime` `registry` option; a and b share display 0 successfully; b's display 1 offer rejects with `status === 409`.
- [ ] **Step 3: Verify failure.** Run `node --test apps/server/tests/control-lease.test.mjs apps/server/tests/stream-runtime.test.mjs`. Expected: failures in the rewritten and new cases.
- [ ] **Step 4: Implement,** then run `node --test apps/server/tests/control-lease.test.mjs apps/server/tests/stream-runtime.test.mjs apps/server/tests/stream-http.test.mjs apps/server/tests/multi-session.test.mjs`. Expected: all pass. `stream-http.test.mjs` should pass unchanged: its two same-profile streams from one session now share one source, and `media.workers.size` is still 1 after the video stop and 0 after disconnect. Change that file only if an assertion truly depends on per-stream workers, and note why in the commit body.
- [ ] **Step 5: Commit** `feat(server): share workers between identical subscriptions with per-peer control and recovery`

---

### Task 7: Production wiring, CLI and host UI

**Files:**
- Modify: `apps/server/src/main.mjs:49-51`
- Modify: `apps/server/src/cli/format.mjs` (`formatSessions`)
- Modify: `apps/windows-host/HostWindow.Sessions.cs` (`StreamVisual`)
- Modify: `apps/windows-host/tests/Navigation/App.xaml.cs` (multi-stream fixture, around lines 520–543)
- Test: the CLI test file that covers `formatSessions` (find it with a search for `formatSessions` / `Waiting for a display stream` under `apps/server/tests`; if none exists, create `apps/server/tests/cli-sessions-format.test.mjs`)

**Interfaces:**
- Consumes: `status()` stream rows `viewers` (Task 6).

**Required behaviour:**
- `main.mjs`: `maxWorkers: 12`, with the comment "Eight video sources plus two audio formats, each of which may briefly have a closing predecessor; registry budgets decide what starts." Drop the now-unused `MAX_SESSIONS_LIMIT` import only if nothing else in the file uses it.
- CLI: the sessions table columns become `['Stream', 'Display', 'Size', 'Target', 'Profile', 'Shared']`; the cell is `×N` when `viewers > 1`, otherwise empty.
- Host: `StreamVisual` gets a small secondary label under the header showing `Shared · N devices`, visible only when `viewers > 1`. Read `viewers` with `TryGetProperty` (missing = 1) and update it in place in `Update(row)`; stream visuals must stay stable across ticks.
- Navigation fixture: set `"viewers": 2` on `stream-one` and on `stream-three`. Assert exactly two `TextBlock`s with text `Shared · 2 devices`, and that the existing stable-plot assertion still holds after the second `update.Invoke`.

- [ ] **Step 1: Write failing tests.** CLI: a status with one stream at `viewers: 2` and one at `viewers: 1` → the output contains a `Shared` header, `×2` on the first row and no `×` on the second. Navigation: the fixture and assertion above.
- [ ] **Step 2: Verify failure.** Run `node --test <cli test file>`. Expected: FAIL (no `Shared` column).
- [ ] **Step 3: Implement** the CLI column, the host label and `main.mjs`.
- [ ] **Step 4: Verify.**
  - `node --test <cli test file> apps/server/tests/cli-parity.test.mjs` → PASS
  - `dotnet build apps/windows-host/tests/Navigation/Navigation.csproj`, then run the Navigation test the way the repo does → it prints no `Exception`
  - If the host exe is locked by a running host (MSB3027), ask the user to close it rather than killing it.
- [ ] **Step 5: Commit** `feat: show shared streams in host sessions and CLI; size workers for shared sources`

---

### Task 8: Browser and hardware regression checks

**Files:**
- Modify: `apps/web-client/tests/stream-browser-check.mjs` (fake media and diagnostics assertions)
- Modify: `native/media-worker/tests/multi-stream-check.mjs` (worker counts and metrics lookups)

**Interfaces:**
- Consumes: the `NativeMedia` method surface (Task 3) and `runtime.streamDiagnostics`/`runtime.audio`/`registry.sources()` (Task 6).

**Required behaviour:**
- `stream-browser-check.mjs`: the fake `media` implements `workers`, `start(sourceId, plan)` (stores `{ id, video: plan.video, peers: new Set() }`), `addPeer(sourceId, peerId, sdp)` (today's sender-page negotiation, keyed by `peerId` and using the source's `video` flag), `removePeer(sourceId, peerId)` (closes that sender peer), `stop(sourceId)` (closes its peers, deletes, `onExit(sourceId, { expected: true })`), `shutdown`, `setPermission` (resolves false), `keyframe` (returns false). The two "metrics are reported" assertions read `runtime.streamDiagnostics.get(id).snapshot().client` for `runtime.audio` ids and `runtime.registry.list()` ids.
- `multi-stream-check.mjs`:
  - metrics lookups use `runtime.streamDiagnostics.get(id)`
  - expected worker count = `runtime.registry.sources().length`, asserted as `displays.length > 1 ? 3 : 2`: display 0 shared by both viewers, display 1 for viewer 0, one shared audio worker
  - after viewer 0 disconnects: `media.workers.size === 2`
  - update the PASS line to mention shared sources

  The control transfer section now exercises transfer between two peers of one worker; keep its assertions.

- [ ] **Step 1: Update both checks.**
- [ ] **Step 2: Run** (both need a Playwright path; the second needs the Windows/NVIDIA machine):
  - `node apps/web-client/tests/stream-browser-check.mjs <playwright path>` → PASS
  - `node native/media-worker/tests/multi-stream-check.mjs <playwright path>` → PASS, with no worker stderr
  - `node native/media-worker/tests/shared-stream-check.mjs <playwright path>` → PASS (rerun after the server changes)
  - `node tests/system/browser-media-check.mjs <playwright path>` → PASS (legacy compatibility `offer` with audio on and off)
- [ ] **Step 3: Run the portable suite once** as the final gate: `npm test`. Expected: PASS. List every failing test name if not.
- [ ] **Step 4: Commit** `test: update browser and hardware checks for shared sources`

---

## Self-review against the spec

| Spec section | Task |
| --- | --- |
| Sources/subscriptions, states, matching key, budgets, registry API | 5 |
| Runtime lifecycle (offer, stop, session, revalidate) | 6 |
| NativeMedia API, worker records, legacy compatibility `offer` | 3 |
| Native pipelines, protocol, per-peer state, input rules, add/remove | 2 (helpers in 1) |
| Control: per-peer permission, transfer, fail closed via remove then stop | 1, 2, 3, 6 |
| Recovery: per-subscription trips, 2 s source limit, join coalescing | 1, 2, 3, 6 |
| Telemetry split, `viewers`, per-subscription diagnostics | 2, 3, 6 |
| Failures table (exit, peer-failed, timeout, pre-ready failure, removal timeout, budgets) | 3, 6 |
| Host UI `Shared · N devices`, CLI `Shared` column | 7 |
| `maxWorkers` 12 | 7 |
| Risks 1–5 verified first | 4 (gate before 5) |
| Testing: native unit tests, synthetic registry/runtime/control/recovery/audio tests, hardware acceptance, navigation fixture | 1, 3, 4, 5, 6, 7, 8 |

Type and name check:
- `start`/`addPeer`/`removePeer`/`setPermission(sourceId, peerId, allowed)`/`keyframe` are named identically in Tasks 3, 4, 6 and 8.
- `subscribe`/`unsubscribe`/`markReady`/`closeSource`/`releaseSource`/`sourceOf`/`subscription`/`sources`/`list(sessionId, kind)` are identical in Tasks 5, 6 and 8.
- `streamDiagnostics`, `viewers` and `audioViewers` are identical in Tasks 6, 7 and 8.

---

## Appendix A: Reference code for Task 1

This is a draft written while planning. Implementers may use it as-is or adapt it; the task's behaviour list is the contract.

`native/media-worker/src/peer-permission.hpp`:

```cpp
#pragma once
#include <cstdint>
#include <string>
#include "host-input-permission.hpp"

// One permitted peer per source worker. Only owner-pipe commands change it; client pings cannot.
class PeerPermission {
    HostInputPermission lease;
    std::string owner;

  public:
    // An unknown peer means the server's view is stale: refuse it and clear the current owner.
    void grant(const std::string &peer, bool known, std::int64_t now, std::int64_t duration) {
        lease.revoke();
        owner.clear();
        if (!known || peer.empty())
            return;
        lease.grant(now, duration);
        if (lease.allowed(now))
            owner = peer;
    }
    void revoke(const std::string &peer) {
        if (peer != owner)
            return;
        lease.revoke();
        owner.clear();
    }
    bool allowed(const std::string &peer, std::int64_t now) const {
        return !owner.empty() && peer == owner && lease.allowed(now);
    }
    const std::string &permitted() const { return owner; }
};
```

`native/media-worker/src/keyframe-limiter.hpp`:

```cpp
#pragma once
#include <cstdint>
#include <limits>

// Join keyframes coalesce briefly; recovery keyframes keep the source-wide 2 s limit.
class KeyframeLimiter {
    static constexpr std::int64_t never = std::numeric_limits<std::int64_t>::min() / 2;
    std::int64_t last_join = never, last_recovery = never;
    static bool take(std::int64_t &last, std::int64_t now, std::int64_t interval) {
        if (now - last < interval)
            return false;
        last = now;
        return true;
    }

  public:
    bool join(std::int64_t now) { return take(last_join, now, 500); }
    bool recovery(std::int64_t now) { return take(last_recovery, now, 2000); }
};
```

`native/media-worker/src/sdp-payload.hpp`:

```cpp
#pragma once
#include <gst/sdp/sdp.h>
#include <cstring>
#include <string>

struct OfferPayloads {
    std::string video, audio;
};

// "102 H264/90000" -> "102". Payload numbers are interpolated into gst_parse descriptions,
// so anything but 1-3 digits <= 127 is refused.
inline std::string rtpmap_payload(const char *value) {
    const auto space = value ? std::strchr(value, ' ') : nullptr;
    if (!space || space == value || space - value > 3)
        return {};
    std::string candidate(value, space);
    for (const char c : candidate)
        if (c < '0' || c > '9')
            return {};
    return std::stoi(candidate) <= 127 ? candidate : std::string();
}

inline GstSDPMessage *parse_offer(const std::string &text) {
    if (text.empty() || text.size() > 65536)
        return nullptr;
    GstSDPMessage *sdp = nullptr;
    gst_sdp_message_new(&sdp);
    if (gst_sdp_message_parse_buffer(reinterpret_cast<const guint8 *>(text.data()),
                                     static_cast<guint>(text.size()), sdp) != GST_SDP_OK ||
        !gst_sdp_message_get_version(sdp) || gst_sdp_message_medias_len(sdp) < 1) {
        gst_sdp_message_free(sdp);
        return nullptr;
    }
    return sdp;
}

// Constrained-baseline H.264 with packetization-mode=1 (the last match wins, as before) and
// the first Opus payload.
inline OfferPayloads select_payloads(const GstSDPMessage *sdp) {
    OfferPayloads result;
    for (guint m = 0; m < gst_sdp_message_medias_len(sdp); ++m) {
        const auto media = gst_sdp_message_get_media(sdp, m);
        const auto kind = gst_sdp_media_get_media(media);
        for (guint a = 0; a < gst_sdp_media_attributes_len(media); ++a) {
            const auto attribute = gst_sdp_media_get_attribute(media, a);
            if (g_strcmp0(attribute->key, "rtpmap") != 0 || !attribute->value)
                continue;
            const auto candidate = rtpmap_payload(attribute->value);
            if (candidate.empty())
                continue;
            if (g_strcmp0(kind, "video") == 0 && strstr(attribute->value, "H264/90000")) {
                for (guint f = 0; f < gst_sdp_media_attributes_len(media); ++f) {
                    const auto fmtp = gst_sdp_media_get_attribute(media, f);
                    if (g_strcmp0(fmtp->key, "fmtp") == 0 && fmtp->value &&
                        std::string(fmtp->value).rfind(candidate + " ", 0) == 0 &&
                        strstr(fmtp->value, "packetization-mode=1") &&
                        strstr(fmtp->value, "profile-level-id=42e0"))
                        result.video = candidate;
                }
            }
            if (g_strcmp0(kind, "audio") == 0 && result.audio.empty() &&
                (strstr(attribute->value, " opus/48000/2") || strstr(attribute->value, " opus/48000")))
                result.audio = candidate;
        }
    }
    return result;
}
```

`native/media-worker/tests/peer-permission.cpp`:

```cpp
#include <cassert>
#include "../src/peer-permission.hpp"
int main() {
    PeerPermission permission;
    permission.grant("a", true, 1000, 5000);
    assert(permission.allowed("a", 1000) && !permission.allowed("b", 1000));
    permission.grant("b", true, 2000, 5000);
    assert(!permission.allowed("a", 2000) && permission.allowed("b", 2000));
    permission.revoke("a");
    assert(permission.allowed("b", 2000));
    permission.revoke("b");
    assert(!permission.allowed("b", 2000) && permission.permitted().empty());
    permission.grant("b", true, 3000, 5000);
    permission.grant("ghost", false, 3500, 5000);
    assert(!permission.allowed("b", 3500) && !permission.allowed("ghost", 3500));
    assert(permission.permitted().empty());
    permission.grant("a", true, 4000, 5000);
    assert(permission.allowed("a", 8999) && !permission.allowed("a", 9000));
    permission.grant("a", true, 4000, 5001);
    assert(!permission.allowed("a", 4000) && permission.permitted().empty());
    permission.grant("", true, 4000, 5000);
    assert(permission.permitted().empty());
}
```

`native/media-worker/tests/keyframe-limiter.cpp`:

```cpp
#include <cassert>
#include "../src/keyframe-limiter.hpp"
int main() {
    KeyframeLimiter limiter;
    assert(limiter.join(0));
    assert(!limiter.join(499));
    assert(limiter.join(500));
    assert(limiter.recovery(100));
    assert(!limiter.recovery(2099));
    assert(limiter.recovery(2100));
    assert(limiter.join(1000));
}
```

`native/media-worker/tests/sdp-payload.cpp`:

```cpp
#include <gst/gst.h>
#include <cassert>
#include <string>
#include "../src/sdp-payload.hpp"
static OfferPayloads payloads(const std::string &text) {
    auto sdp = parse_offer(text);
    assert(sdp);
    auto result = select_payloads(sdp);
    gst_sdp_message_free(sdp);
    return result;
}
int main(int argc, char **argv) {
    gst_init(&argc, &argv);
    const std::string head = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n";
    const std::string video =
        head + "m=video 9 UDP/TLS/RTP/SAVPF 96 98 102\r\n"
               "a=rtpmap:96 VP8/90000\r\n"
               "a=rtpmap:98 H264/90000\r\n"
               "a=fmtp:98 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f\r\n"
               "a=rtpmap:102 H264/90000\r\n"
               "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n";
    assert(payloads(video).video == "102");
    assert(payloads(video).audio.empty());
    const std::string audio = head + "m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\n";
    assert(payloads(audio).audio == "111" && payloads(audio).video.empty());
    const std::string baseline =
        head + "m=video 9 UDP/TLS/RTP/SAVPF 100\r\na=rtpmap:100 H264/90000\r\n"
               "a=fmtp:100 packetization-mode=1;profile-level-id=42001f\r\n";
    assert(payloads(baseline).video.empty());
    const std::string injected =
        head + "m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96!fakesink H264/90000\r\n"
               "a=fmtp:96!fakesink packetization-mode=1;profile-level-id=42e01f\r\n";
    assert(payloads(injected).video.empty());
    assert(rtpmap_payload("128 opus/48000/2").empty());
    assert(rtpmap_payload("111").empty());
    assert(rtpmap_payload(nullptr).empty());
    assert(!parse_offer("invalid"));
    assert(!parse_offer(std::string(65537, 'v')));
}
```

`CMakeLists.txt`: add `peer-permission keyframe-limiter sdp-payload` to the test `foreach` list, and after `target_link_libraries(stream-profile-test PRIVATE gstreamer_sdk)` add `target_link_libraries(sdp-payload-test PRIVATE gstreamer_sdk gstsdp-1.0)`.

---

## Appendix B: Reference code for Task 2 (`media-worker.cpp`)

This is a draft written while planning; it has not been compiled. Each block names what it replaces. Blocks not mentioned stay unchanged:
- `virtual_desktop`, `capture_display_current`, `AudioTelemetry`, `begin_shutdown`
- `request_keyframe`, `recovery_probe`, `attach_recovery`
- `inject`, `key_input`, `button_input`
- `parse_object`, `string_member`, `fatal`, `number_member`
- `pipeline_description`, `preflight`, `count_frame`, `self_test`
- `set_profile`, `set_display`, `main`

### B1. Includes and globals

After `#include "transport-telemetry.hpp"` add:

```cpp
#include <memory>
#include <vector>
#include "peer-permission.hpp"
#include "keyframe-limiter.hpp"
#include "sdp-payload.hpp"
```

Delete `static TransportTelemetry transport_telemetry;` and `static gint64 last_recovery = 0;`. Replace the block from `static GMainLoop *loop = nullptr;` through `static GstWebRTCDataChannel *input_channel = nullptr;` with:

```cpp
static GMainLoop *loop = nullptr;
static GstElement *pipeline = nullptr;
static bool failed = false;
static bool started = false;
static bool playing = false;
static StreamProfile profile;
static bool video_enabled = true;
static int audio_channels = 0; // 0: no audio chain; 1: mono-32k; 2: stereo-96k
static bool host_control_required = false;
static PeerPermission peer_permission;
static KeyframeLimiter keyframe_limiter;
static std::set<WORD> held_keys;
static std::set<int> held_buttons;

// One viewer: leaky queue, payloader and webrtcbin inside a bin fed by the source tees.
struct Peer {
    std::string id;
    unsigned index = 0;
    GstElement *bin = nullptr;                                 // owned reference
    GstElement *webrtc = nullptr;                              // borrowed from bin
    GstPad *video_tee_pad = nullptr, *audio_tee_pad = nullptr; // owned request pads
    GstWebRTCDataChannel *input_channel = nullptr;             // owned reference
    bool answered = false, removing = false, notify_closed = false;
    int pending_unlinks = 0;
    bool control = false;
    gint64 last_ping = 0, rate_window = 0;
    int rate_count = 0;
    std::shared_ptr<std::atomic<int>> pending_input = std::make_shared<std::atomic<int>>(0);
    TransportTelemetry transport;
};
// GStreamer threads never touch a Peer. Callbacks carry a copy of this reference and look the
// peer up on the main loop; the index rejects callbacks for a removed peer whose id was reused.
struct PeerRef {
    std::string id;
    unsigned index;
    std::shared_ptr<std::atomic<int>> pending_input;
};
static std::map<std::string, std::unique_ptr<Peer>> peers;
static unsigned next_peer_index = 0;
static Peer *find_peer(const PeerRef &ref) {
    const auto found = peers.find(ref.id);
    return found != peers.end() && found->second->index == ref.index ? found->second.get()
                                                                      : nullptr;
}
static PeerRef *peer_ref(const Peer &peer) {
    return new PeerRef{peer.id, peer.index, peer.pending_input};
}
static void delete_ref(gpointer data) { delete static_cast<PeerRef *>(data); }
static void delete_closure_ref(gpointer data, GClosure *) { delete_ref(data); }
static gint64 now_ms() { return g_get_monotonic_time() / 1000; }
static void fail_peer(Peer &peer, const char *reason);
static void remove_peer(const std::string &id, bool notify);
```

### B2. Replace `release_input`

```cpp
static void release_held() {
    auto keys = held_keys;
    auto buttons = held_buttons;
    for (auto key : keys)
        key_input(key, false);
    for (auto button : buttons)
        button_input(button, false);
}
// Held keys and buttons are OS state; only a peer that had control can have pressed them.
static void revoke_peer(Peer &peer, bool notify) {
    if (peer.control)
        release_held();
    peer.control = false;
    if (notify && peer.input_channel)
        gst_webrtc_data_channel_send_string(peer.input_channel, "{\"control\":false}");
}
// Lost ping (5 s) or a missing/expired host lease ends a peer's control.
static void enforce_permission() {
    const auto now = g_get_monotonic_time();
    for (auto &entry : peers) {
        auto &peer = *entry.second;
        if (peer.control &&
            (now - peer.last_ping > 5 * G_USEC_PER_SEC ||
             (host_control_required && !peer_permission.allowed(peer.id, now / 1000))))
            revoke_peer(peer, true);
    }
}
```

### B3. Replace `output`; add `boolean_member` after `number_member`

```cpp
static void write_object(JsonObject *object) {
    auto node = json_node_new(JSON_NODE_OBJECT);
    json_node_take_object(node, object);
    auto text = json_to_string(node, false);
    std::cout << text << std::endl;
    g_free(text);
    json_node_free(node);
}
static void emit(const char *type,
                 std::initializer_list<std::pair<const char *, std::string>> fields = {}) {
    auto object = json_object_new();
    json_object_set_string_member(object, "type", type);
    for (const auto &field : fields)
        json_object_set_string_member(object, field.first, field.second.c_str());
    write_object(object);
}
```

```cpp
static bool boolean_member(JsonObject *object, const char *name) {
    auto node = json_object_get_member(object, name);
    return node && JSON_NODE_HOLDS_VALUE(node) &&
           json_node_get_value_type(node) == G_TYPE_BOOLEAN && json_node_get_boolean(node);
}
```

### B4. Replace `input_message` through `channel_created`

```cpp
struct InputMessage {
    PeerRef ref;
    std::string text;
};
static gboolean input_message(gpointer data) {
    auto &message = *static_cast<InputMessage *>(data);
    --*message.ref.pending_input;
    const auto peer = find_peer(message.ref);
    if (!peer || peer->removing)
        return G_SOURCE_REMOVE;
    JsonParser *parser = nullptr;
    auto object = parse_object(message.text, &parser);
    if (object && !capture_display_current()) {
        release_held();
        fatal("Capture display changed. Reconnect.");
        g_object_unref(parser);
        return G_SOURCE_REMOVE;
    }
    if (object) {
        const auto allowed = [&] {
            return !host_control_required || peer_permission.allowed(peer->id, now_ms());
        };
        if (peer->control && !allowed())
            revoke_peer(*peer, false);
        std::string type = string_member(object, "type");
        if (type == "ping")
            peer->last_ping = g_get_monotonic_time();
        else if (type == "release")
            revoke_peer(*peer, false);
        else if (type == "control") {
            revoke_peer(*peer, false);
            peer->control = allowed() && boolean_member(object, "enabled");
            peer->last_ping = g_get_monotonic_time();
            if (peer->control)
                for (auto &entry : peers)
                    if (entry.second.get() != peer && entry.second->control)
                        revoke_peer(*entry.second, true);
        } else if (peer->control) {
            auto now = g_get_monotonic_time();
            if (now - peer->rate_window > G_USEC_PER_SEC) {
                peer->rate_window = now;
                peer->rate_count = 0;
            }
            if (++peer->rate_count > 1000)
                revoke_peer(*peer, false);
            else if (type == "move") {
                double x = number_member(object, "x"), y = number_member(object, "y");
                if (valid_point(x, y)) {
                    INPUT input{};
                    input.type = INPUT_MOUSE;
                    const auto bounds = capture_display
                                            ? capture_display->bounds
                                            : DesktopRect{0, 0, GetSystemMetrics(SM_CXSCREEN),
                                                          GetSystemMetrics(SM_CYSCREEN)};
                    if (auto point = desktop_point(x, y, bounds, virtual_desktop())) {
                        input.mi.dx = point->x;
                        input.mi.dy = point->y;
                        input.mi.dwFlags =
                            MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
                        inject(input);
                    }
                }
            } else if (type == "key") {
                WORD vk = key_code(string_member(object, "code"));
                auto down = json_object_get_member(object, "down");
                if (vk && down && json_node_get_value_type(down) == G_TYPE_BOOLEAN)
                    key_input(vk, json_node_get_boolean(down));
            } else if (type == "button") {
                double button = number_member(object, "button");
                auto down = json_object_get_member(object, "down");
                if (std::isfinite(button) && button == std::floor(button) && button >= 0 &&
                    button <= 2 && down && json_node_get_value_type(down) == G_TYPE_BOOLEAN)
                    button_input(static_cast<int>(button), json_node_get_boolean(down));
            } else if (type == "wheel") {
                double delta = number_member(object, "delta");
                if (std::isfinite(delta) && std::abs(delta) <= 1200) {
                    INPUT input{};
                    input.type = INPUT_MOUSE;
                    input.mi.dwFlags = MOUSEEVENTF_WHEEL;
                    input.mi.mouseData = static_cast<DWORD>(static_cast<LONG>(delta));
                    inject(input);
                }
            }
        }
    }
    if (peer->input_channel)
        gst_webrtc_data_channel_send_string(peer->input_channel, peer->control
                                                                     ? "{\"control\":true}"
                                                                     : "{\"control\":false}");
    g_object_unref(parser);
    return G_SOURCE_REMOVE;
}
static void channel_message(GstWebRTCDataChannel *, gchar *text, gpointer data) {
    const auto &ref = *static_cast<PeerRef *>(data);
    if (!text || strlen(text) > 1024)
        return;
    if (++*ref.pending_input > 256) {
        --*ref.pending_input;
        return;
    }
    g_main_context_invoke_full(
        nullptr, G_PRIORITY_DEFAULT, input_message, new InputMessage{ref, text},
        [](gpointer message) { delete static_cast<InputMessage *>(message); });
}
static void channel_closed(GstWebRTCDataChannel *, gpointer data) {
    g_main_context_invoke_full(
        nullptr, G_PRIORITY_DEFAULT,
        [](gpointer ref) -> gboolean {
            if (const auto peer = find_peer(*static_cast<PeerRef *>(ref)))
                revoke_peer(*peer, false);
            return G_SOURCE_REMOVE;
        },
        new PeerRef(*static_cast<PeerRef *>(data)), delete_ref);
}
struct ChannelAttach {
    PeerRef ref;
    GstWebRTCDataChannel *channel;
};
static void channel_created(GstElement *, GstWebRTCDataChannel *channel, gpointer data) {
    gchar *label = nullptr;
    g_object_get(channel, "label", &label, nullptr);
    const bool input = video_enabled && g_strcmp0(label, "input") == 0;
    g_free(label);
    if (!input) {
        gst_webrtc_data_channel_close(channel);
        return;
    }
    const auto &ref = *static_cast<PeerRef *>(data);
    // Queue the attach before connecting message handlers so replies always find the channel.
    g_main_context_invoke_full(
        nullptr, G_PRIORITY_DEFAULT,
        [](gpointer value) -> gboolean {
            auto &attach = *static_cast<ChannelAttach *>(value);
            const auto peer = find_peer(attach.ref);
            if (peer && !peer->removing && !peer->input_channel)
                std::swap(peer->input_channel, attach.channel);
            return G_SOURCE_REMOVE;
        },
        new ChannelAttach{ref, GST_WEBRTC_DATA_CHANNEL(g_object_ref(channel))},
        [](gpointer value) {
            auto attach = static_cast<ChannelAttach *>(value);
            if (attach->channel)
                g_object_unref(attach->channel);
            delete attach;
        });
    g_signal_connect_data(channel, "on-message-string", G_CALLBACK(channel_message),
                          new PeerRef(ref), delete_closure_ref, GConnectFlags(0));
    g_signal_connect_data(channel, "on-close", G_CALLBACK(channel_closed), new PeerRef(ref),
                          delete_closure_ref, GConnectFlags(0));
}
```

### B5. Add after `pipeline_description`

```cpp
static std::string audio_source_description() {
    return "wasapisrc name=audio-capture loopback=true low-latency=true ! audioconvert ! "
           "audioresample ! audio/x-raw,format=S16LE,layout=interleaved,rate=48000,channels=" +
           std::to_string(audio_channels) + " ! opusenc name=audio-encoder bitrate=" +
           std::string(audio_channels == 1 ? "32000" : "96000") +
           " bitrate-type=cbr frame-size=20 inband-fec=true ! "
           "tee name=audio-fanout allow-not-linked=true";
}
```

### B6. Replace `bus_message`

```cpp
static Peer *peer_of(GstObject *object) {
    for (auto current = object; current; current = GST_OBJECT_PARENT(current))
        for (auto &entry : peers)
            if (GST_OBJECT(entry.second->bin) == current)
                return entry.second.get();
    return nullptr;
}
static gboolean bus_message(GstBus *, GstMessage *message, gpointer) {
    if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_QOS)
        telemetry.qos(message);
    if (GST_MESSAGE_TYPE(message) == GST_MESSAGE_ERROR) {
        GError *error = nullptr;
        gchar *debug = nullptr;
        gst_message_parse_error(message, &error, &debug);
        if (error_log.is_open())
            error_log << "GSTREAMER ERROR source=" << GST_OBJECT_NAME(message->src)
                      << " message=" << (error ? error->message : "unknown")
                      << " debug=" << (debug ? debug : "none") << std::endl;
        // A viewer's transport failing must not end the shared capture for everyone else.
        if (const auto peer = peer_of(message->src))
            fail_peer(*peer, error ? error->message : "WebRTC peer error.");
        else
            fatal(error ? error->message : "GStreamer error");
        if (error)
            g_error_free(error);
        g_free(debug);
    }
    return G_SOURCE_CONTINUE;
}
```

### B7. Replace `send_answer` through `remote_set` (everything before `set_profile`)

```cpp
struct PeerTask {
    PeerRef ref;
    void (*run)(Peer &);
};
// Runs on the main loop; references to removed or removing peers are ignored.
static void on_main(const PeerRef &ref, void (*run)(Peer &)) {
    g_main_context_invoke_full(
        nullptr, G_PRIORITY_DEFAULT,
        [](gpointer data) -> gboolean {
            auto &task = *static_cast<PeerTask *>(data);
            if (const auto peer = find_peer(task.ref); peer && !peer->removing)
                task.run(*peer);
            return G_SOURCE_REMOVE;
        },
        new PeerTask{ref, run}, [](gpointer data) { delete static_cast<PeerTask *>(data); });
}
static void send_answer(Peer &peer) {
    if (peer.answered || peer.removing)
        return;
    GstWebRTCICEGatheringState state;
    g_object_get(peer.webrtc, "ice-gathering-state", &state, nullptr);
    if (state != GST_WEBRTC_ICE_GATHERING_STATE_COMPLETE)
        return;
    GstWebRTCSessionDescription *description = nullptr;
    g_object_get(peer.webrtc, "local-description", &description, nullptr);
    if (!description)
        return;
    auto text = gst_sdp_message_as_text(description->sdp);
    emit("answer", {{"peerId", peer.id}, {"sdp", text}});
    g_free(text);
    gst_webrtc_session_description_free(description);
    peer.answered = true;
}
static void gathering_changed(GObject *, GParamSpec *, gpointer data) {
    on_main(*static_cast<PeerRef *>(data), send_answer);
}
static void connection_changed(GObject *, GParamSpec *, gpointer data) {
    on_main(*static_cast<PeerRef *>(data), [](Peer &peer) {
        GstWebRTCPeerConnectionState state;
        g_object_get(peer.webrtc, "connection-state", &state, nullptr);
        if (state == GST_WEBRTC_PEER_CONNECTION_STATE_FAILED)
            fail_peer(peer, "WebRTC connection failed.");
        // RTP sent before DTLS connects is dropped, so the join keyframe waits for connected.
        else if (state == GST_WEBRTC_PEER_CONNECTION_STATE_CONNECTED && video_enabled &&
                 keyframe_limiter.join(now_ms()))
            request_keyframe(pipeline);
    });
}
struct AnswerResult {
    PeerRef ref;
    GstWebRTCSessionDescription *answer;
};
static void answer_created(GstPromise *promise, gpointer data) {
    auto result = new AnswerResult{*static_cast<PeerRef *>(data), nullptr};
    if (const auto reply = gst_promise_get_reply(promise))
        gst_structure_get(reply, "answer", GST_TYPE_WEBRTC_SESSION_DESCRIPTION, &result->answer,
                          nullptr);
    gst_promise_unref(promise);
    g_main_context_invoke_full(
        nullptr, G_PRIORITY_DEFAULT,
        [](gpointer value) -> gboolean {
            auto &result = *static_cast<AnswerResult *>(value);
            const auto peer = find_peer(result.ref);
            if (!peer || peer->removing)
                return G_SOURCE_REMOVE;
            if (!result.answer) {
                fail_peer(*peer, "Unable to create WebRTC answer.");
                return G_SOURCE_REMOVE;
            }
            auto set = gst_promise_new();
            g_signal_emit_by_name(peer->webrtc, "set-local-description", result.answer, set);
            gst_promise_interrupt(set);
            gst_promise_unref(set);
            send_answer(*peer);
            return G_SOURCE_REMOVE;
        },
        result,
        [](gpointer value) {
            auto result = static_cast<AnswerResult *>(value);
            if (result->answer)
                gst_webrtc_session_description_free(result->answer);
            delete result;
        });
}
static void remote_set(GstPromise *promise, gpointer data) {
    const PeerRef ref = *static_cast<PeerRef *>(data); // copy: unref may free data
    gst_promise_unref(promise);
    on_main(ref, [](Peer &peer) {
        auto answer = gst_promise_new_with_change_func(answer_created, peer_ref(peer), delete_ref);
        g_signal_emit_by_name(peer.webrtc, "create-answer", nullptr, answer);
    });
}
static void destroy_peer(const std::string &id) {
    auto node = peers.extract(id);
    if (node.empty())
        return;
    auto &peer = *node.mapped();
    for (const auto &[name, pad] : std::initializer_list<std::pair<const char *, GstPad *>>{
             {"video-fanout", peer.video_tee_pad}, {"audio-fanout", peer.audio_tee_pad}}) {
        if (!pad)
            continue;
        auto tee = gst_bin_get_by_name(GST_BIN(pipeline), name);
        gst_element_release_request_pad(tee, pad);
        gst_object_unref(tee);
        gst_object_unref(pad);
    }
    if (peer.input_channel)
        g_object_unref(peer.input_channel);
    gst_element_set_state(peer.bin, GST_STATE_NULL);
    gst_bin_remove(GST_BIN(pipeline), peer.bin);
    gst_object_unref(peer.bin);
    if (peer.notify_closed)
        emit("peer-closed", {{"peerId", peer.id}});
}
static GstPadProbeReturn unlink_probe(GstPad *pad, GstPadProbeInfo *, gpointer data) {
    if (const auto target = gst_pad_get_peer(pad)) {
        gst_pad_unlink(pad, target);
        gst_object_unref(target);
    }
    // Never change element state from a streaming thread; g_idle_add also defers when the
    // probe fired synchronously inside remove_peer.
    g_idle_add_full(
        G_PRIORITY_DEFAULT,
        [](gpointer value) -> gboolean {
            const auto &ref = *static_cast<PeerRef *>(value);
            const auto peer = find_peer(ref);
            if (peer && --peer->pending_unlinks == 0)
                destroy_peer(ref.id);
            return G_SOURCE_REMOVE;
        },
        new PeerRef(*static_cast<PeerRef *>(data)), delete_ref);
    return GST_PAD_PROBE_REMOVE;
}
static void remove_peer(const std::string &id, bool notify) {
    const auto found = peers.find(id);
    if (found == peers.end()) {
        if (notify)
            emit("peer-closed", {{"peerId", id}});
        return;
    }
    auto &peer = *found->second;
    peer.notify_closed = peer.notify_closed || notify;
    if (peer.removing)
        return;
    peer_permission.revoke(peer.id);
    revoke_peer(peer, true);
    peer.removing = true;
    const PeerRef ref{peer.id, peer.index, peer.pending_input};
    std::vector<GstPad *> pads;
    for (auto pad : {peer.video_tee_pad, peer.audio_tee_pad})
        if (pad)
            pads.push_back(pad);
    peer.pending_unlinks = static_cast<int>(pads.size());
    if (pads.empty()) {
        destroy_peer(id);
        return;
    }
    for (auto pad : pads)
        gst_pad_add_probe(pad, GST_PAD_PROBE_TYPE_IDLE, unlink_probe, new PeerRef(ref), delete_ref);
}
static void fail_peer(Peer &peer, const char *reason) {
    if (peer.removing)
        return;
    if (error_log.is_open())
        error_log << "PEER FAILED id=" << peer.id << " reason=" << reason << std::endl;
    emit("peer-failed", {{"peerId", peer.id}, {"reason", reason}});
    remove_peer(peer.id, false);
}
static void add_peer(const std::string &id, const std::string &text) {
    const auto refuse = [&](const std::string &reason) {
        emit("peer-failed", {{"peerId", id}, {"reason", reason}});
    };
    if (!pipeline)
        return refuse("Source not started.");
    if (peers.count(id))
        return refuse("Duplicate peer.");
    const auto sdp = parse_offer(text);
    if (!sdp)
        return refuse("Invalid SDP");
    const auto payloads = select_payloads(sdp);
    const char *unsupported =
        video_enabled && payloads.video.empty()
            ? "Browser must offer constrained-baseline H.264 with packetization-mode=1."
        : audio_channels && payloads.audio.empty() ? "Browser must offer Opus audio."
                                                   : nullptr;
    if (unsupported) {
        gst_sdp_message_free(sdp);
        return refuse(unsupported);
    }
    auto owned = std::make_unique<Peer>();
    auto &peer = *owned;
    peer.id = id;
    peer.index = next_peer_index++;
    const auto video_ssrc = std::to_string(10000001u + 2u * peer.index);
    const auto audio_ssrc = std::to_string(20000001u + 2u * peer.index);
    // webrtcbin requires explicit SSRC on the payloader and in the outgoing RTP caps
    // during SDP answer creation. Without this, webrtcbin emits FID 0 <rtx-ssrc> and
    // attaches MSID only to the RTX repair stream, causing the browser to decode RTP
    // packets but fail to route frames to the MediaStreamTrack (video readyState remains 0).
    const std::string video_branch =
        "queue leaky=downstream max-size-buffers=8 max-size-time=200000000 max-size-bytes=0 ! "
        "rtph264pay mtu=" +
        std::to_string(profile.mtu) + " config-interval=-1 pt=" + payloads.video +
        " aggregate-mode=" + (profile.fps == 15 ? "none" : "zero-latency") +
        " ssrc=" + video_ssrc +
        " ! application/x-rtp,media=video,encoding-name=H264,ssrc=(uint)" + video_ssrc +
        " ! identity name=video-output";
    const std::string audio_branch =
        "queue leaky=downstream max-size-time=100000000 max-size-buffers=5 ! rtpopuspay pt=" +
        payloads.audio + " mtu=1200 ssrc=" + audio_ssrc +
        " ! application/x-rtp,media=audio,encoding-name=OPUS,ssrc=(uint)" + audio_ssrc +
        " ! identity name=audio-output";
    if (error_log.is_open())
        error_log << "PEER id=" << id
                  << " video=" << (video_enabled ? video_branch : std::string("off"))
                  << " audio=" << (audio_channels ? audio_branch : std::string("off")) << std::endl;
    peer.bin = GST_ELEMENT(
        gst_object_ref_sink(gst_bin_new(("peer-" + std::to_string(peer.index)).c_str())));
    peer.transport.attach(peer.bin);
    std::string failure;
    peer.webrtc = gst_element_factory_make("webrtcbin", "webrtc");
    if (!peer.webrtc)
        failure = "Unable to create WebRTC peer.";
    else {
        g_object_set(peer.webrtc, "bundle-policy", GST_WEBRTC_BUNDLE_POLICY_MAX_BUNDLE, "latency",
                     0, nullptr);
        g_signal_connect(
            peer.webrtc, "on-new-transceiver",
            G_CALLBACK(+[](GstElement *, GstWebRTCRTPTransceiver *transceiver, gpointer) {
                g_object_set(transceiver, "do-nack", TRUE, nullptr);
            }),
            nullptr);
        gst_bin_add(GST_BIN(peer.bin), peer.webrtc);
    }
    const auto add_branch = [&](const std::string &description, const char *ghost) {
        if (!failure.empty())
            return;
        GError *error = nullptr;
        auto branch = gst_parse_bin_from_description(description.c_str(), TRUE, &error);
        if (error || !branch) {
            failure = error ? error->message : "Unable to create peer branch.";
            if (error)
                g_error_free(error);
            if (branch)
                gst_object_unref(branch);
            return;
        }
        gst_bin_add(GST_BIN(peer.bin), GST_ELEMENT(branch));
        auto sink = gst_element_get_static_pad(GST_ELEMENT(branch), "sink");
        if (!sink || !gst_element_link(GST_ELEMENT(branch), peer.webrtc) ||
            !gst_element_add_pad(peer.bin, gst_ghost_pad_new(ghost, sink)))
            failure = "Unable to link peer branch to WebRTC.";
        if (sink)
            gst_object_unref(sink);
    };
    // Link order matches the previous single-peer pipeline: video first, then audio.
    if (video_enabled)
        add_branch(video_branch, "video_sink");
    if (audio_channels)
        add_branch(audio_branch, "audio_sink");
    if (!failure.empty()) {
        gst_sdp_message_free(sdp);
        gst_object_unref(peer.bin);
        return refuse(failure);
    }
    g_signal_connect_data(peer.webrtc, "notify::ice-gathering-state",
                          G_CALLBACK(gathering_changed), peer_ref(peer), delete_closure_ref,
                          GConnectFlags(0));
    g_signal_connect_data(peer.webrtc, "notify::connection-state", G_CALLBACK(connection_changed),
                          peer_ref(peer), delete_closure_ref, GConnectFlags(0));
    g_signal_connect_data(peer.webrtc, "on-data-channel", G_CALLBACK(channel_created),
                          peer_ref(peer), delete_closure_ref, GConnectFlags(0));
    peers.emplace(id, std::move(owned));
    gst_bin_add(GST_BIN(pipeline), peer.bin);
    // Bring the branch up before linking so the tee never pushes into a flushing pad.
    if (playing)
        gst_element_sync_state_with_parent(peer.bin);
    const auto link = [&](const char *tee_name, const char *ghost, GstPad *&tee_pad) {
        auto tee = gst_bin_get_by_name(GST_BIN(pipeline), tee_name);
        tee_pad = gst_element_request_pad_simple(tee, "src_%u");
        gst_object_unref(tee);
        auto sink = gst_element_get_static_pad(peer.bin, ghost);
        const bool linked = tee_pad && sink && gst_pad_link(tee_pad, sink) == GST_PAD_LINK_OK;
        if (sink)
            gst_object_unref(sink);
        return linked;
    };
    if (!((!video_enabled || link("video-fanout", "video_sink", peer.video_tee_pad)) &&
          (!audio_channels || link("audio-fanout", "audio_sink", peer.audio_tee_pad)))) {
        gst_sdp_message_free(sdp);
        return fail_peer(peer, "Unable to link peer to the shared source.");
    }
    if (!playing) {
        // Nothing is captured or encoded until the first viewer is linked.
        playing = true;
        gst_element_set_state(pipeline, GST_STATE_PLAYING);
    }
    auto offer = gst_webrtc_session_description_new(GST_WEBRTC_SDP_TYPE_OFFER, sdp);
    auto promise = gst_promise_new_with_change_func(remote_set, peer_ref(peer), delete_ref);
    g_signal_emit_by_name(peer.webrtc, "set-remote-description", offer, promise);
    gst_webrtc_session_description_free(offer);
}
```

### B8. Replace `start_offer`

Move the unchanged `set_display` above this function.

```cpp
static void start_source(JsonObject *object) {
    if (started)
        return fatal("Source already started");
    started = true;
    video_enabled = boolean_member(object, "video");
    host_control_required = boolean_member(object, "hostControl");
    const std::string format = string_member(object, "audioFormat");
    audio_channels = format == "mono-32k" ? 1 : format == "stereo-96k" ? 2 : 0;
    if (!format.empty() && !audio_channels)
        return fatal("Invalid audio format");
    if (!video_enabled && !audio_channels)
        return fatal("Audio sources require an audio format");
    if (video_enabled && !set_profile(object))
        return fatal("Invalid stream profile");
    if (video_enabled && !set_display(object))
        return fatal("Selected display is unavailable or changed");
    std::string description;
    if (video_enabled)
        description = pipeline_description() + " ! tee name=video-fanout allow-not-linked=true";
    if (audio_channels)
        description += (description.empty() ? "" : "  ") + audio_source_description();
    if (error_log.is_open())
        error_log << "SOURCE " << description << std::endl;
    GError *error = nullptr;
    pipeline = gst_parse_launch(description.c_str(), &error);
    if (error || !pipeline) {
        fatal(error ? error->message : "Unable to create the shared source.");
        if (error)
            g_error_free(error);
        return;
    }
    if (video_enabled) {
        telemetry.attach(pipeline);
        attach_recovery(pipeline);
    }
    audio_telemetry.attach(pipeline);
    auto bus = gst_element_get_bus(pipeline);
    gst_bus_add_watch(bus, bus_message, nullptr);
    gst_object_unref(bus);
    emit("ready");
}
```

### B9. Replace `command`

```cpp
static gboolean command(gpointer data) {
    auto text = static_cast<std::string *>(data);
    JsonParser *parser = nullptr;
    auto object = parse_object(*text, &parser);
    if (!object)
        fatal("Invalid command JSON");
    else {
        std::string type = string_member(object, "type");
        const std::string peer_id = string_member(object, "peerId");
        const bool valid_peer = !peer_id.empty() && peer_id.size() <= 64;
        if (type == "start")
            start_source(object);
        else if (type == "add-peer" && valid_peer)
            add_peer(peer_id, string_member(object, "sdp"));
        else if (type == "remove-peer" && valid_peer)
            remove_peer(peer_id, true);
        else if (type == "control-permission") {
            auto allowed = json_object_get_member(object, "allowed");
            auto request = number_member(object, "requestId");
            auto duration = number_member(object, "leaseMs");
            if (!valid_peer || !allowed || !JSON_NODE_HOLDS_VALUE(allowed) ||
                json_node_get_value_type(allowed) != G_TYPE_BOOLEAN || !std::isfinite(request) ||
                request < 1 || request > 9007199254740991.0 || request != std::floor(request) ||
                !std::isfinite(duration) || duration < 1 || duration > 5000) {
                release_held();
                fatal("Invalid control permission");
            } else {
                const auto now = now_ms();
                const auto found = peers.find(peer_id);
                const bool known = video_enabled && found != peers.end() && !found->second->removing;
                if (json_node_get_boolean(allowed))
                    peer_permission.grant(peer_id, known, now, static_cast<gint64>(duration));
                else {
                    peer_permission.revoke(peer_id);
                    if (found != peers.end())
                        revoke_peer(*found->second, true);
                }
                // Granting one peer ends control for every other peer of this source.
                enforce_permission();
                std::cout << "{\"type\":\"control-result\",\"requestId\":"
                          << static_cast<gint64>(request) << ",\"allowed\":"
                          << (peer_permission.allowed(peer_id, now) ? "true" : "false") << "}"
                          << std::endl;
            }
        } else if (type == "stop")
            begin_shutdown();
        else if (type == "keyframe") {
            if (video_enabled && pipeline && keyframe_limiter.recovery(now_ms())) {
                bool accepted = request_keyframe(pipeline);
                if (error_log.is_open())
                    error_log << "RECOVERY force-key-unit accepted=" << accepted << std::endl;
            }
        } else
            fatal("Invalid command");
    }
    g_object_unref(parser);
    delete text;
    return G_SOURCE_REMOVE;
}
```

### B10. `session()` timer body and teardown

Timer lambda body (replaces everything from `if (!capture_display_current()) {` to `return G_SOURCE_CONTINUE;`):

```cpp
            if (!capture_display_current()) {
                release_held();
                fatal("Capture display changed. Reconnect.");
                return G_SOURCE_REMOVE;
            }
            if (pipeline && !peers.empty()) {
                auto sample = telemetry.snapshot();
                audio_telemetry.merge(sample);
                json_object_set_string_member(sample, "type", "metrics");
                json_object_set_int_member(sample, "forceKeyUnitEvents", force_events.load());
                json_object_set_int_member(sample, "encodedKeyframes", keyframes.load());
                json_object_set_int_member(sample, "spsProfile", sps_profile.load());
                json_object_set_int_member(sample, "spsLevel", sps_level.load());
                auto rows = json_object_new();
                for (auto &entry : peers) {
                    if (entry.second->removing)
                        continue;
                    auto row = json_object_new();
                    entry.second->transport.merge(entry.second->bin, row);
                    json_object_set_object_member(rows, entry.first.c_str(), row);
                }
                json_object_set_object_member(sample, "peers", rows);
                write_object(sample);
            }
            enforce_permission();
            return G_SOURCE_CONTINUE;
```

Teardown after `g_main_loop_run(loop);` (through `return failed ? 1 : 0;`):

```cpp
    release_held();
    if (pipeline)
        gst_element_set_state(pipeline, GST_STATE_NULL);
    for (auto &entry : peers) {
        for (auto pad : {entry.second->video_tee_pad, entry.second->audio_tee_pad})
            if (pad)
                gst_object_unref(pad);
        if (entry.second->input_channel)
            g_object_unref(entry.second->input_channel);
        gst_object_unref(entry.second->bin);
    }
    peers.clear();
    if (pipeline)
        gst_object_unref(pipeline);
    // Process exit reclaims the stdin reader; it never owns capture resources.
    return failed ? 1 : 0;
```
