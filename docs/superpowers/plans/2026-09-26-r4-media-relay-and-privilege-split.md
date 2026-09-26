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

- [ ] Pull the branch, then run the portable suite: `npm test`.
- [ ] Run the check with audio (P1):

  ```powershell
  node native/media-worker/tests/relay-check.mjs C:\path\to\playwright
  ```

  The first run rebuilds the worker with the `VIDVNC_ICE_BIND` change. Expected: every line
  `PASS`, the selected local candidate reported for each peer, and the relay counters.
  If the answer fails validation, the check prints the offending line and the full answer:
  add the attribute to the allow-list in `sdp-candidates.mjs` only if it is harmless.

- [ ] Run it with video for P2, once at 1080p60 and once with `--seconds 60`:

  ```powershell
  node native/media-worker/tests/relay-check.mjs C:\path\to\playwright --video --seconds 60
  ```

  Then run the same with `--direct` for the baseline (no relay, the worker gathers on every
  interface as today). Gate: the relay adds at most 1 ms at the 95th percentile.

- [ ] Firefox and Safari (P1, by hand): not automated yet. Record whether they connect
      through the relay; if one rejects the loopback mapped address, implement the relay's
      XOR-MAPPED-ADDRESS rewrite (spec, "Mapped addresses") before phase 1.

### Task 0.3: Gate P3 and P4 (native prototype)

- [ ] A minimal `media-worker.exe --network` that starts under the tier T1 token (spec,
      "Token for `media-net`"), preloads plugins under the impersonation token, calls
      `RevertToSelf`, then runs `appsrc ! tee ! webrtcbin` fed from a pipe.
- [ ] Check in the MSIX layout and the CLI layout (unzipped into the profile): Winsock UDP on
      loopback after `RevertToSelf`; a profile file cannot be opened; another `media-net`
      cannot open this process; no plugin loads after lowering. Record the tier (T1, T2 or T3).
- [ ] P4: enable Win32k lockdown and ACG one at a time and record what breaks.

### Task 0.4: Gate P5 (firewall) and P6 (iCloud Private Relay)

- [ ] On a test VM: inbound and outbound block rules for `media-worker.exe`, then run
      `relay-check.mjs`; loopback must keep working.
- [ ] As a standard user, read the rules through `HNetCfg.FwPolicy2`.
- [ ] Try an MSIX manifest block rule; record whether it is supported.
- [ ] Record whether Windows prompts for `node.exe` when only port-scoped rules exist.
- [ ] P6: an iPhone on mobile data with iCloud Private Relay on, through the relay (after
      phase 1's server integration, or with a manual `relay-check`-style setup). Record the
      HTTPS and media addresses and whether it connects.

## Phase 1: relay for every session, media port, firewall rules

Expand each task into steps once phase 0 is recorded.

- [ ] **1.1 Relay process and manager:** `media-relay/main.mjs` (protocol table in the spec),
      `MediaRelay` in the server (start before `ready`, restart at most 3 times a minute,
      stop all streams on exit), metrics and events to diagnostics and the server log.
- [ ] **1.2 Worker binding:** `iceBind: () => 'loopback'` for every worker; remove
      `VIDVNC_ICE_PORTS` from the launch.
- [ ] **1.3 Signaling:** in `stream-runtime.mjs`, strip offer candidates, validate the answer,
      register with the relay and wait for `allowed` before returning the answer; announce
      the relay address per client (public IPv4 and global IPv6 for internet clients, the
      HTTPS local address otherwise, with link-local mapped to its interface); revoke on
      every exit path in the spec's list.
- [ ] **1.4 Settings:** `mediaPort` (default 4384) with migration from `mediaPorts`, CLI
      `media-port` and the deprecated `media-ports` alias, host field and remote access text,
      relay restart on change.
- [ ] **1.5 Firewall (F1):** rule set from settings, audit through `HNetCfg.FwPolicy2`,
      `firewall`, `firewall apply`, `firewall remove` in the CLI, the host's Firewall card,
      in-memory `-EncodedCommand` elevation, MSIX manifest rules for the default ports.
- [ ] **1.6 Sessions and diagnostics:** HTTPS and media address per stream; relay counters.
- [ ] **1.7 Documentation and release notes** per the spec's documentation list; R4 status
      "reduced".

## Phase 2: privilege split

- [ ] **2.1 Sandbox launcher** (`--sandbox`) and `media-net` (`--network`) with the recorded
      token tier, job, desktop and mitigations.
- [ ] **2.2 Pipes:** overlapped named pipes, writer and reader threads, bounded queues, record
      formats, overflow to keyframe.
- [ ] **2.3 Pipeline split:** `appsink` in the worker, `appsrc` in `media-net`, per-peer
      branches moved, keyframe kinds, `channel-closed`, metrics merge.
- [ ] **2.4 Broker:** input from the pipe through the existing checks; refuse to run without
      `hostControl`.
- [ ] **2.5 Answer attestation:** `check-port` with `GetExtendedUdpTable`.
- [ ] **2.6 Relay at low integrity** through `--sandbox`.
- [ ] **2.7 Firewall:** outbound block for `media-worker.exe`.
- [ ] **2.8 Documentation**; R4 status "mitigated".
