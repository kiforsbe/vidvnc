# R4 Media Relay, Firewall Rules and Privilege Split Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking. Phase 0 runs on
> the owner's Windows machine; do not start phase 1 until every gate has a recorded result.

**Goal:** Close R4: no unauthenticated sender reaches libnice's STUN parser, the WebRTC stack
runs sandboxed without input, file or network reach, and the worker needs no inbound firewall
permission.

**Architecture:** A Node relay owns one UDP media port for every session and forwards a
client's datagrams to a loopback-only `webrtcbin` only after the client proves the session's
ICE password. The media worker later splits into a medium-integrity capture, encode and input
process and a sandboxed network process. Firewall rules are scoped by program and port and
applied by the owner with one UAC prompt.

**Tech stack:** Node.js 20.6+ (`dgram`, `crypto`, `node:test`), C++/GStreamer 1.28.6 worker,
Win32 security APIs for the sandbox, PowerShell `NetSecurity` cmdlets for firewall rules, the
WinUI host. No new dependency.

**Spec:** [r4-media-relay-and-privilege-split-design.md](../specs/2026-09-26-r4-media-relay-and-privilege-split-design.md)
(revision 2).

## Global constraints

- Every new component fails closed; no runtime fallback to a weaker configuration (token tier,
  binding, or skipped check).
- The relay never replies to an unpinned sender. The client's HTTPS address is a hint, never a
  gate.
- Nothing parses SDP from the sandboxed network process in C; validation happens in the server.
- Documentation lands with each change, per [AGENTS.md](../../../AGENTS.md).
- The `mediaPort` settings change is a minor version.

## File structure

| File                                                       | Role                                                                               | Status (2026-09-26)        |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------- |
| `apps/server/src/media-relay/stun.mjs`                     | STUN parsing, MESSAGE-INTEGRITY and FINGERPRINT verification                       | Done, tested               |
| `apps/server/src/media-relay/relay.mjs`                    | Relay core: registrations, budget lanes, pinning, classification, forwarding       | Done, tested               |
| `apps/server/src/sdp-candidates.mjs`                       | `stripOfferCandidates`, `iceCredentials`, `validateRelayAnswer`, `announceRelay`   | Done, tested               |
| `apps/server/src/native-media.mjs`                         | `iceBind` option → `VIDVNC_ICE_BIND`                                               | Done, tested               |
| `native/media-worker/src/media-worker.cpp`                 | `VIDVNC_ICE_BIND=loopback` → `add-local-ip-address("127.0.0.1")`                   | Done, **not compiled yet** |
| `native/media-worker/tests/relay-check.mjs`                | Windows acceptance check for gates P1 and P2                                       | Done, **not run yet**      |
| `apps/server/src/media-relay/main.mjs` (new)               | Relay process: JSON-lines protocol on stdin/stdout, exit on EOF or invalid command | Phase 1                    |
| `apps/server/src/media-relay.mjs` (new)                    | `MediaRelay` manager: spawn, supervise, restart, register/revoke                   | Phase 1                    |
| `apps/server/src/access-settings.mjs`, CLI, host           | `mediaPort` setting and migration                                                  | Phase 1                    |
| `apps/server/src/stream-runtime.mjs`, `http-app.mjs`       | Relay registration before the answer; revocation on every exit path                | Phase 1                    |
| `apps/server/src/firewall/` (new), host, CLI               | Rule set, audit, elevated apply                                                    | Phase 1                    |
| `native/media-worker/src/` (new sandbox and network files) | `--network` and `--sandbox` modes, token, job, desktop, pipes, broker              | Phase 2                    |

## Phase 0: prototype gates

Record each result in the spec's gate table (and, for security-relevant results, in the
security analysis's verification record) before phase 1 starts.

### Task 0.1: STUN and relay core (portable) — done

- [x] `stun.mjs` with RFC 5769 request and response vectors, bit flips, truncation, attributes
      after MESSAGE-INTEGRITY, `MESSAGE-INTEGRITY-SHA256`, username rules, 200,000 random
      buffers (`apps/server/tests/media-relay-stun.test.mjs`).
- [x] `relay.mjs` with fake-network tests for pinning, re-verification on pinned paths,
      classes, loopback source checks, budget lanes under a forged-source flood, hint
      mismatches, shared ufrags, expiry, idle, revoke, pin limits, validation, dual-stack bind
      and fallback, plus one real-socket loopback test
      (`apps/server/tests/media-relay-core.test.mjs`).
- [x] SDP helpers with tests (`apps/server/tests/sdp-candidates.test.mjs`).

### Task 0.2: Gate P1 and P2 on Windows (owner)

- [x] Pull the branch, then run the portable suite: `npm test`. **2026-09-26, owner's Windows
      machine:** 899/899 passed.
- [x] Run the check with audio (P1). **First run, 2026-09-26:** failed before any gate
      question, with "Unable to bind WebRTC to loopback" on the first peer: libnice parses the
      address with `getaddrinfo`, which fails on Windows until Winsock is started. Fixed by
      calling `WSAStartup` when `VIDVNC_ICE_BIND=loopback` is set. **Second run, 2026-09-26,
      Chromium: P1 passed.** Each worker offered a single `127.0.0.1` UDP host candidate; both
      answers passed relay-mode validation; two peer connections completed ICE and DTLS through
      the relay's one port 4384 as peer-reflexive candidates; the browser accepted the loopback
      mapped address (selected local candidate `prflx`, address hidden by Chrome); `netstat`
      showed the workers' UDP sockets only on `127.0.0.1` and no TCP listener; the relay
      dropped nothing and matched both client hints. The single round-trip sample (42 ms) was
      not a usable P2 measure, so the check now reports the time each datagram spends inside
      the relay, the browser's receive jitter and packet loss, and the mean ICE round trip.

  ```powershell
  node native/media-worker/tests/relay-check.mjs C:\path\to\playwright
  ```

  The first run rebuilds the worker with the `VIDVNC_ICE_BIND` change. Expected: every line
  `PASS`, the selected local candidate reported for each peer, and the relay counters.
  If the answer fails validation, the check prints the offending line and the full answer:
  add the attribute to the allow-list in `sdp-candidates.mjs` only if it is harmless.

- [x] Run it with video for P2, once at 1080p60 and once with `--seconds 60`:

  ```powershell
  node native/media-worker/tests/relay-check.mjs C:\path\to\playwright --video --seconds 60
  ```

  Then run the same with `--direct` for the baseline (no relay, the worker gathers on every
  interface as today). Gate: the relay adds at most 1 ms at the 95th percentile.

  **2026-09-26, owner's Windows machine, two 1080p60 H.264 streams (Media Foundation,
  20 Mbit/s each), browser on the same PC through its LAN address: P2 passed at 1080p60.**

  | Measure                            | Through the relay                                            | Direct                       |
  | ---------------------------------- | ------------------------------------------------------------ | ---------------------------- |
  | Time inside the relay per datagram | p50 0.009 ms, p95 0.032 ms, p99 0.057 ms (168,913 datagrams) | —                            |
  | Mean ICE round trip                | 1.37 ms (52 checks)                                          | 0.23 ms (53 checks)          |
  | Receive jitter                     | p50 3 ms, p95 5 ms, p99 5 ms                                 | p50 3 ms, p95 5 ms, p99 5 ms |
  | Packets received, lost             | 168,608, 0                                                   | 156,462, 0                   |

  The relay's own processing is far inside the 1 ms gate, and jitter and loss are unchanged.
  The mean ICE round trip rose by about 1.1 ms, which is two relay traversals (about 0.6 ms
  each way); the per-datagram timing does not include the wait between the kernel receiving a
  datagram and Node's event loop handling it, which is the likely difference. Not yet
  measured: 4K30, a busy host, and a client on another machine.

- [x] Firefox and Safari (P1, by hand): both connect through the built-in relay (owner's
      report, 2026-09-26), so the loopback mapped address is accepted and no
      XOR-MAPPED-ADDRESS rewrite is needed.

### Task 0.3: Gate P3 and P4 (native prototype)

Prototype, 2026-09-26: `native/media-worker/src/sandbox.hpp` (the tier T1 launcher, reusable in
phase 2) and `native/media-worker/tests/sandbox-probe.cpp`, run with
`node native/media-worker/tests/sandbox-check.mjs`. The probe starts a copy of itself in the
sandbox; the copy loads GStreamer while impersonating the initial token, calls `RevertToSelf`,
then reports whether it can read a file in the profile, open another sandboxed process, start a
child process, use UDP on loopback, and gather on loopback with `webrtcbin` (including DTLS
certificate generation). It compiles with MinGW in the Linux container (GStreamer stubbed).

First Windows run, 2026-09-26: it built, and the parent created the desktop and started the
child, but the child exited with 0xC0000142 (`STATUS_DLL_INIT_FAILED`) before its first line:
a DLL failed to initialise, so no probe code ran. The launch used `CREATE_NO_WINDOW`, which
gives a console program a hidden console and so a `conhost.exe`; the job allows one process and
the child-process policy forbids children, which is the likely cause. The launcher now starts
the child with `DETACHED_PROCESS`. `sandbox-check.mjs` now reruns a failing probe with each part
of the sandbox turned off in turn (`--relax detached`, `job`, `desktop`, `mitigations`,
`object-security`, `initial-token`, `restricted`, then all of them) to isolate the cause if that
is not it.

Second run, 2026-09-26, Windows 10.0.26200, GStreamer 1.28.6, the development build (CLI layout,
repository under the user profile): **P3 passes at tier T1** with `DETACHED_PROCESS`, so the
console was the cause. The child started impersonating the initial token, started Winsock,
initialised GStreamer and preloaded coreelements, app, rtp, rtpmanager, webrtc, nice, dtls, srtp
and sctp, then called `RevertToSelf`. On the primary token it ran at low integrity (RID 4096,
0x1000), restricted, with the user SID deny-only. Denied: reading a file in
`%LOCALAPPDATA%\VidVNC` (error 5), `OpenProcess` on itself (error 5), starting `cmd.exe` (error
367, `ERROR_CHILD_PROCESS_BLOCKED`). It ran on the alternate desktop. Still working: UDP on
loopback, and `webrtcbin` gathering on 127.0.0.1 with a DTLS fingerprint. Its own executable is
not readable after lowering, so every library must load before `RevertToSelf`. Not yet checked:
the MSIX layout, and the real worker (`--network` with `appsrc ! tee ! webrtcbin`) rather than
the probe.

`sandbox-check.mjs` now also runs gate P4 when P3 passes: the probe again with Arbitrary Code
Guard, Win32k lockdown, and both, turned on at run time after lowering, reporting which checks
break.

P4 run, 2026-09-26, same machine and build, both turned on at run time with
`SetProcessMitigationPolicy` after `RevertToSelf`:

| Mitigation                 | Result                                                                     |
| -------------------------- | -------------------------------------------------------------------------- |
| Arbitrary Code Guard (ACG) | Turns on; UDP and `webrtcbin` gathering with DTLS still pass.              |
| Win32k lockdown            | Refused with error 5: it cannot be turned on once the process uses Win32k. |
| Both                       | ACG turns on; Win32k lockdown is refused as above.                         |

Decisions for phase 2: turn ACG on in `media-net` after preloading, and keep a check for it.
Before relying on it, run the real `--network` pipeline under ACG: ORC, which some GStreamer
elements use to generate code at run time, needs executable memory, and the probe does not
exercise it. Win32k lockdown can only be set at process creation, and then `user32.dll` must
not load at all; GLib's main loop uses `user32.dll`, so it does not fit GStreamer without
changes we do not control. Leave it out; the job's UI limits and the alternate desktop remain
the Win32k controls. (Creation-time lockdown was not tried.)

- [ ] A minimal `media-worker.exe --network` that starts under the tier T1 token (spec,
      "Token for `media-net`"), preloads plugins under the impersonation token, calls
      `RevertToSelf`, then runs `appsrc ! tee ! webrtcbin` fed from a pipe.
- [ ] Check in the MSIX layout and the CLI layout (unzipped into the profile): Winsock UDP on
      loopback after `RevertToSelf`; a profile file cannot be opened; another `media-net`
      cannot open this process; no plugin loads after lowering. Record the tier (T1, T2 or T3).
      CLI layout (development build): T1 passes with the probe, above. MSIX: not yet.
- [x] P4: enable Win32k lockdown and ACG one at a time and record what breaks (above).

### Task 0.4: Gate P5 (firewall) and P6 (iCloud Private Relay)

- [ ] On a test VM: inbound and outbound block rules for `media-worker.exe`, then run
      `relay-check.mjs`; loopback must keep working.
- [ ] As a standard user, read the rules through `HNetCfg.FwPolicy2`.
- [ ] Try an MSIX manifest block rule; record whether it is supported.
- [ ] Record whether Windows prompts for `node.exe` when only port-scoped rules exist.
- [x] P6: an iPhone with iCloud Private Relay on connects through the built-in relay (owner's
      report, 2026-09-26). Whether its HTTPS and media addresses differed was not recorded;
      Sessions marks it when they do.

## Phase 1: relay for every session, media port, firewall rules

Built on 2026-09-26 and validated on the owner's Windows machine the same day (see the
security analysis's verification record). Only 1.5 (firewall) remains.

- [x] **1.1 Relay process and manager:** `media-relay/main.mjs` and `protocol.mjs` (the
      spec's protocol table, plus `refused` for a well-formed registration the relay cannot
      hold, and `failed` for a port it cannot bind), `media-relay.mjs` (`MediaRelay`: start
      before `ready`, restart at most 3 times a minute, `onExit` stops every stream, a
      once-a-minute log summary of unauthenticated drops).
- [x] **1.2 Worker binding:** `iceBind: () => 'loopback'` for every worker;
      `VIDVNC_ICE_PORTS` is no longer set. The worker's own range support stays for the
      `media-ports-check.mjs` harness; remove it in phase 2.
- [x] **1.3 Signaling:** `StreamRuntime` strips offer candidates, validates the answer,
      awaits `allow` before answering and announces `relay-addresses.mjs`'s addresses; every
      exit path goes through `#forget`, which revokes; `expired` ends the stream; a relay
      exit stops all streams. The legacy `/api/offer` path (no runtime) is unchanged and
      unused by the server.
- [x] **1.4 Settings:** `mediaPort` (default 4384) with migration from `mediaPorts` in the
      file and in changes from older hosts; CLI `media-port` and the deprecated
      `media-ports`; the host's field; relay restart on change.
- [ ] **1.5 Firewall (F1):** not started. Waits for gate P5 on a test VM.
- [x] **1.6 Sessions and diagnostics:** the media address per stream in the host's Sessions
      and the CLI's `sessions`; `media-relay` in the CLI; relay state in the host status (an
      error bar when media is unavailable). The diagnostics page does not show relay
      counters yet.
- [x] **1.7 Documentation and release notes:** ARCHITECTURE (media relay section and
      diagrams, security architecture), internet-exposure (R4 reduced), remote-access,
      README, CHANGELOG (Unreleased, with the downgrade note). Packaging notes wait for F1.

Windows, 2026-09-26: `npm run test:hardware` 18/18 and `npm run test:host` 30/30; the host
built and ran. Through the built-in relay: a browser on the LAN, an iPhone from the internet
through the owner's router, Firefox and Safari (P1), and the iPhone with iCloud Private Relay
on (P6) all streamed; the media worker's UDP sockets were on `127.0.0.1` only.

## Phase 2: privilege split

Built 2026-09-26 in the Linux container: `media-net.cpp`, `net-pipes.hpp`, `net-records.hpp`
(unit test `net-records`), `json-util.hpp`, and the worker changes. Both translation units
pass a MinGW syntax check against the GStreamer 1.24 headers with a win64 GLib config; the
record test runs under Linux g++. Not yet built with MSVC or run on Windows.

Deviations from the spec, deliberate: anonymous pipes instead of named ones (no name at all,
so nothing to squat, and four handles in the handle list: control each way, frames, input);
blocking I/O on dedicated threads instead of overlapped I/O (the main loop still never
waits on a pipe); `ready` is held until media-net reports `net-ready`, and viewers that
arrive before then wait in the worker; capture starts at the first answer.

Windows, 2026-09-26, owner's machine: the MSVC build is clean; `npm run test:hardware` 18/18
(the worker session tests start media-net and hand it a viewer). `relay-check.mjs --video`
passed through the relay and media-net: 2 peers at 1080p60, ICE and DTLS complete, every
worker UDP socket on 127.0.0.1, 23,207 packets received and 0 lost; time inside the relay p95
0.034 ms. The mean ICE round trip was 3.20 ms over 15 checks (1.37 ms over 52 in the phase 0
run); ICE checks do not cross the new pipes, so this is likely noise, to be watched. Not yet
checked: the host app with a real browser and an iPhone, input through the broker, and the
`NET ready` line in `native-worker.log`.

- [x] **2.1 Sandbox launcher** for media-net (`--network`) with tier T1, job, desktop and
      mitigations (`sandbox.hpp`, detached); Arbitrary Code Guard after `RevertToSelf`. The
      relay's `--sandbox` launcher is 2.6.
- [x] **2.2 Pipes:** writer and reader threads, bounded queues (frames 32 MiB, control
      4 MiB), record formats, overflow to keyframe.
- [x] **2.3 Pipeline split:** `appsink` in the worker, `appsrc` in media-net, per-peer
      branches moved, keyframe kinds, `channel-closed`, metrics merge.
- [x] **2.4 Broker:** input from the pipe through the existing checks; refuse to run without
      `hostControl`. The worker's ICE port range (`VIDVNC_ICE_PORTS`) and its check script are
      removed; media-net always gathers on 127.0.0.1.
- [x] **2.5 Answer attestation:** `check-port` with `GetExtendedUdpTable`
      (`NativeMedia.checkPort`, called in `StreamRuntime` before `allow`; fails closed on a
      timeout or worker exit).

First app run, 2026-09-26: video stopped after a second or two, locally and remotely. Likely
cause: media-net had no standard handles of its own, so it inherited the worker's handle
values, invalid in media-net, and strict handle checks turn the first write to stderr into a
crash. Fixed by giving it the `NUL` device and routing GLib and GStreamer messages to the
worker's log; the worker now logs media-net's exit code, and media-net logs connection and
data channel events, caps and a frame count every 5 seconds. To be confirmed on Windows.

- [ ] **2.6 Relay at low integrity** through `--sandbox`.
- [ ] **2.7 Firewall:** outbound block for `media-worker.exe`.
- [ ] **2.8 Documentation**; R4 status "mitigated".
