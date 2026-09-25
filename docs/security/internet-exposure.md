# Internet exposure: security analysis and status

**Status as of 2026-09-25, branch `claude/remote-access-on-main`** (`main` at `90a37e4` plus
the remote access work). This is the single, current security analysis for exposing VidVNC
beyond the local network. It replaces the separate reviews, remediation proposals and status
notes written between 2026-09-23 and 2026-09-25 (see [History](#history)). The operator's
setup steps are in the [remote access guide](remote-access.md); the support position is in
[SECURITY.md](../../SECURITY.md).

This is a source review with targeted probes and regression tests. It is **not** a
penetration test, an internet deployment, or a hardware/network exercise.

## Bottom line

- **On a trusted LAN:** the service is hardened.
  - Admission is metered.
  - Plaintext HTTP only listens on local addresses.
  - It fails closed when HTTPS is missing.
  - Diagnostics are isolated.
  - Revocation is enforced.
- **Remote access is off (the default):** every client with an internet source address is
  refused.
- **Remote access is on:** no route was found that lets an unauthenticated internet client
  see the screen, send input or manage the host. Internet clients:
  - must use HTTPS;
  - can only sign in as approved devices;
  - can never use an 8-character code, device setup, certificate enrolment or diagnostics.

The findings of the 2026-09-25 review (R1–R8) are fixed in code, except the two that no code
change can close.

**Remote access is still not validated:**

1. The **media path hasn't run on hardware** (R8). The native port range and the
   ICE-TCP switch are uncompiled, and no real router, mobile network or packet capture has
   been used.
2. **The native ICE stack faces the internet on the media ports** while a stream is live
   (R4, reduced to UDP only). That is inherent to direct WebRTC.
3. **Two conditions depend on your setup.** An internet flood can still exhaust the
   _internet_ sign-in budget; it no longer affects the LAN (R1). And the boundary relies on
   a genuine source address. This is now contained by the `approved-only` requirement and a
   required setup check (R2).

Until R8 has been exercised, the recommended way to reach VidVNC from outside is a
self-hosted VPN with remote access left off.

## Scope and assumptions

In scope:

- the Node HTTP/HTTPS server and its separate diagnostics listener;
- the browser client;
- the native WebRTC media worker, where it is reachable from the network;
- the Windows host's owner commands.

The analysis assumes the operator meets the conditions below. These are **Security-Related
Application Conditions (SecRACs)**: conditions VidVNC can guide, check or warn about, but
cannot fully establish on its own. Where a condition is not met, the analysis says what
changes.

1. **Forward only what the guide lists:** the HTTPS port (TCP) and the media port range
   (UDP), with the same port numbers outside and inside for the media range. Never forward
   the plaintext HTTP port or the diagnostics port.
2. **No same-host reverse proxy, port proxy or NAT that rewrites the client's source
   address.** The client's real source address must reach VidVNC. The guide's
   mobile-data check verifies this, and it is required (see R2).
3. **Certificate identity is verified independently.** Either devices trust a public CA,
   or the self-signed anchor is installed on the LAN and its fingerprint is checked
   against the host.
4. **Codes are handed over securely.** Setup and one-time codes travel over a channel you
   trust, and every pending approval is checked before it is accepted.
5. **An upstream edge absorbs volumetric floods.** VidVNC's in-process limits bound its own
   work; they don't stop a large distributed attack.
6. **Lost credentials are revoked promptly,** and approved-device passwords are strong.

## Deployment profiles

VidVNC supports the first two profiles below. Neither needs a third-party service.

| Profile                                                  | Status                                  | What it needs                                                                      | Trade-off                                                                                                                                                                           |
| -------------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Self-hosted VPN** (WireGuard, Tailscale)               | **Recommended now**                     | A VPN endpoint on the router or PC; remote access stays off                        | One UDP port exposed and no VidVNC port. VPN clients count as private and use the ordinary rules, except the standing password, which stays LAN-only. Every viewer needs VPN setup. |
| **Direct port forwarding** (`remote-access on`)          | **Implemented, not yet validated** (R8) | Public name or IP, HTTPS port and media range forwarded, devices set up on the LAN | No relay and no third party. Media depends on the router and the client's network, and the native ICE stack faces the internet (R4).                                                |
| Owner-run TURN relay (for example coturn on a small VPS) | Not implemented                         | A public host the owner controls                                                   | Works behind carrier-grade NAT and restrictive networks; needs relay-only ICE and short-lived credentials on both peers.                                                            |
| Product-operated outbound relay                          | Not selected                            | A hosted rendezvous and TURN service                                               | No router setup, but it is a new hosted service with its own trust, cost and security review.                                                                                       |

A profile never makes authentication optional. A degraded remote configuration must refuse
internet clients rather than fall back to plaintext or to an unintended route.

## Current exposure map

| Surface                          | Remote access off                                                                                     | Remote access on (internet client)                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| HTTP `4382`                      | Binds loopback and eligible Private-LAN addresses only                                                | Same; an internet peer that still reached it gets `403`                                                                |
| HTTPS `4383`                     | Binds `0.0.0.0`; internet peers get `403` for every route                                             | Public login shell, `/api/info` (public name only), approved-device sign-in and claim status; HSTS on the public names |
| `/api/key-start` (all codes)     | Local and private peers only                                                                          | `403`; no code budget is consumed. For local/private peers only setup codes work (`approved-only` is required)         |
| Viewer assets (`/viewer/…`)      | After admission, with a session- and peer-bound `HttpOnly` cookie                                     | Same                                                                                                                   |
| Session and signaling APIs       | Bearer bound to the socket address                                                                    | Same; offers keep only public-address candidates, answers carry the public address with private addresses removed      |
| Certificate enrolment (`/trust`) | Local peers only                                                                                      | `403`                                                                                                                  |
| Diagnostics                      | `404` on the main ports; separate `127.0.0.1` listener with an owner-issued 256-bit, 15-minute bearer | Same                                                                                                                   |
| Media ports                      | Random ephemeral ports, LAN only                                                                      | Fixed `media-ports` range, UDP only; reachable by anyone while a stream is live (R4)                                   |
| Owner management                 | No HTTP route; host pipe and local CLI only                                                           | Same                                                                                                                   |

Clients count as **local** when they are on an eligible Private physical LAN. That decides
the standing password and certificate enrolment.

**Private** clients are not on this LAN but not the internet either:

- a VPN, loopback or link-local address;
- a `100.64.0.0/10` address, but only while this PC has an adapter in that range (an
  overlay VPN such as Tailscale). Otherwise that range is an ISP's carrier-grade NAT and
  counts as internet;
- an IPv6 unique-local address, or an address in one of this PC's IPv6 prefixes.

Private clients follow the ordinary rules. **Internet** clients are everyone else; an
unknown address fails closed as internet.

## Controls in place

**Owner control (Windows host)**

- **Each start is local-only by default.**
  - The host app starts sharing local-only unless the owner picks **Start sharing with
    remote access**, from the sharing indicator's menu or the Settings card.
  - Starting local-only turns off a remote-access setting saved earlier, for example from
    the CLI.
  - Starting remote also sets `approved-only`. If no public name is configured, sharing
    starts local-only and the host shows why.
- **The start line carries the mode as an exact string.** The owner gate
  (`owner-start.mjs`) still accepts only exact lines: the original `{"type":"start"}` and
  the two `sharing` variants, nothing else.
- **Remote access is visible where sharing is controlled.** The navigation-pane indicator
  shows a warning-coloured globe and "Remote access on", even with the pane collapsed, and
  Overview repeats it.
- **Settings can be changed without turning remote access on.** Settings → Remote access
  saves the public names, public port and media ports while sharing through the host pipe,
  and while sharing is off through the offline `config` command. That command refuses to
  run while a server is running.
- **The source-address check is prompted.** While remote access is on, the card asks the
  owner to check once from mobile data that Sessions shows a public address (R2). Sessions
  lists each device's address.

**Admission**

- Legacy anonymous key-inspection and connect routes are gone.
- `/api/key-start` is metered before any code is looked up:
  - rolling limits of 120 per minute overall and 10 per source;
  - per code class, 20 failures overall and 5 per source for each code generation.
- Codes are 8 characters from `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (about 40 bits) and don't
  encode their purpose.
- One-time and setup codes are issued by the host on request, single-use, and expire after
  300 seconds by default (60–600).
- The reusable standing password is accepted only from local peers.
- Internet peers can't use `/api/key-start` at all.
- **Remote access requires `approved-only` connection mode**, enforced by settings
  validation, the CLI and the host pipe. While it is on, the standing password and one-time
  codes work for nobody, and only setup codes (which need owner approval) remain.
- Approved sign-in, registration and claim polling are budgeted **separately for internet
  peers and for local/private peers**:
  - sign-in and registration: 600 per minute overall and 10 per source;
  - claim polling: 1200 per minute overall and 60 per source;
  - 10 per minute per approved identity.
- Every per-source count groups IPv6 by /64.

**Approved devices**

- Sign-in needs a 256-bit device secret, the username and the password.
- `scrypt` runs only after the secret matches, and at most 4 run at once.
- Each approved identity may have one live session.
- A generation counter invalidates sessions synchronously when the owner edits or removes
  the device.
- Registration needs a host-issued setup code, a one-use ticket, owner approval and a
  one-time claim token. At most 64 requests can be pending.
- The approval screen labels each request from the registering peer's address: Local
  network, Private network (not this LAN) or Internet.

**Sessions and viewer**

- Session bearers are random UUIDs, kept in page memory (not cookies) and bound to the
  socket address.
- Viewer assets load only after admission, through a grant cookie bound to the peer and
  session.
- Every request is checked against the page's strict CSP, `nosniff`, and `Origin` versus
  `Host` (including the port).

**Transport**

- HTTP binds only loopback and eligible Private-LAN addresses.
- If HTTPS fails or its settings are invalid, viewer, admission and signaling over HTTP get
  `503`. When HTTPS is active they redirect.
- Absolute-form request targets must match the listener.
- Internet peers are served over HTTPS only, and the handler checks this again itself.
- Public names are accepted as `Host` values and get HSTS only while remote access is on.
- `public-port` accepts the router's public HTTPS port for those names only.

- Switching remote access off disconnects every internet session at once, with its streams
  and control.
- With remote access on, the generated certificate names the public hosts and omits the
  PC's hostname. The change takes effect at the next reissue.

**Control**

- Current permission is checked at stream selection, grant, native acknowledgment and lease
  renewal.
- A blanket `available` default doesn't grant control automatically to internet sessions;
  only a per-device `available` does.
- Input is whitelisted in the worker and rate-limited to 1000 events/s.

**Resources**

- Request bodies are capped at 128 KiB and SDP at 64 KiB.
- Header and request timeouts are set.
- Each listener allows 32 connections in total and 12 per source address (IPv6 per /64);
  loopback is exempt.
- Admission maps are bounded, and registration and claim state expire.

**Media**

- DTLS-SRTP protects media, and its fingerprints are exchanged over the authenticated
  signaling.
- For internet clients:
  - the offer keeps only candidates on public IP addresses, so a client can't aim the
    host's ICE checks at LAN machines or at hostnames;
  - the answer replaces private host candidates with the public IPv4 on the same ports
    and removes private addresses.
- The worker applies the `media-ports` range to every WebRTC peer, turns ICE-TCP off when
  a range is set, and refuses to start with an invalid range.

## Findings register

Severity reflects an internet-exposed server under the assumptions above. The **F** findings
come from the 2026-09-23 and 2026-09-24 reviews; the **R** findings come from the 2026-09-25
review of the remote access mode.

| ID  | Finding                                                                       | Severity (at discovery) | Status                                                                   |
| --- | ----------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------ |
| R1  | One global sign-in budget let anyone lock all approved devices out            | High (availability)     | Fixed; an internet flood can still block _remote_ sign-in while it lasts |
| R2  | Source-NAT on forwarded connections makes internet clients local              | Medium (conditional)    | Contained (`approved-only` required, source check); residual below       |
| R3  | Client-supplied ICE candidates reached the worker unfiltered                  | Medium                  | Fixed                                                                    |
| R4  | Native ICE/STUN parsing is reachable before authentication on the media ports | Medium (residual)       | Reduced (UDP only); **open**, inherent to direct WebRTC                  |
| R5  | 100.64.0.0/10 was treated as private                                          | Low (conditional)       | Fixed                                                                    |
| R6  | Turning remote access off left internet sessions running up to 20 s           | Low                     | Fixed                                                                    |
| R7  | The generated certificate listed the PC's name and local IPs                  | Low (disclosure)        | Partly fixed (hostname omitted); local IPs remain                        |
| R8  | The media path is not validated on a real network                             | Assurance gap           | **Open**; live local peer passes (range, UDP only, no TCP)               |
| F1  | Connection-key guessing and a key-validity oracle bypassed the rate limit     | High                    | Mitigated; the 8-character code trade-off remains (LAN and private only) |
| F2  | `view-only` changes didn't revoke captured automatic control                  | High                    | Mitigated; a short asynchronous native window remains                    |
| F3  | HTTPS could degrade to HTTP; enrolment was plaintext                          | High                    | Fixed; LAN enrolment still needs a fingerprint check                     |
| F4  | A loopback proxy could expose diagnostics                                     | Medium                  | Fixed                                                                    |
| F5  | An approved-device credential is copyable                                     | Medium                  | Accepted model with mitigations; not device binding                      |
| F6  | Direct WebRTC had no remote network policy                                    | Medium                  | Implemented (port range, UDP only, candidate policy); untested (R4, R8)  |
| F7  | Limits could be exhausted; some state had no lifetime                         | Medium                  | Fixed in process; volumetric floods remain                               |
| F8  | A remote registration was labelled "Local network"                            | Medium (misleading cue) | Fixed                                                                    |
| —   | Public DNS names and routers' public ports were refused (`403`/`421`)         | Compatibility           | Fixed (`public-hosts`, `public-port`)                                    |
| —   | No opt-in remote mode                                                         | Design gap              | Fixed (`remote-access`, off by default)                                  |

## Open and residual findings

### R8: the media changes are validated locally; the real network is not (open)

The worker's `min-rtp-port`/`max-rtp-port` and `ice-tcp` handling compiles, range parsing
works in the real binary, and a live browser peer stays inside the range over UDP only.
What remains is the real network path. A failure fails safe:

- ports outside the forwarded range, or ICE-TCP left on, mean media fails or keeps its old
  exposure;
- neither makes anything reachable that wasn't before.

**Passed on Windows:** the worker compiles with these changes, and `npm run test:hardware`
confirms that a valid range starts while a malformed one exits with code 2 before anything
starts.

**Passed on Windows, with a live peer:**
`node native/media-worker/tests/media-ports-check.mjs <playwright>` connected headless
Chromium through the worker with range 41000–41049. There was 1 UDP candidate inside the
range, 1 worker UDP socket inside the range per `netstat`, no TCP listener, and the browser
connected.

**Still needed:**

- a connection from mobile data through a real router;
- a packet capture showing no ICE checks toward client-chosen internal addresses.

### R4: native parsing is reachable before authentication on the media ports (open, reduced)

While a stream is live, anyone can send UDP to the forwarded range. libnice parses STUN
before it checks message integrity. DTLS and the input data channel follow only after ICE
succeeds with credentials from the authenticated signaling.

No defect is known. The exposure is native parsing in an unsandboxed process that can
inject input. ICE-TCP is off whenever a range is set, so only the UDP parser is exposed.

**Remaining:**

- keep GStreamer and libnice current, and scan them separately from `npm audit`;
- longer term, a lower-privilege worker with a narrow input broker.

### R2: the boundary trusts the source address (contained, conditional)

Every remote-mode rule is keyed to the TCP source address. A router or program that
source-NATs forwarded connections makes internet clients look local: some ISP routers,
NAT reflection, `netsh portproxy`, WSL/Hyper-V forwarding, a reverse proxy.

**Now:** remote access can only be on in `approved-only` mode. A laundered client
therefore can't use the standing password or one-time codes; nobody can. The rest of what
it could do:

- open the certificate page, which serves only public data;
- obtain a registration ticket with a stolen setup code, and submit a setup request that
  the owner must approve. That request would wrongly show "Local network";
- get automatic control if it holds an approved device's credentials and the default is
  `available`.

The [guide](remote-access.md#check-the-source-address) makes a mobile-data check of the
session address a required setup step. The app doesn't detect laundering itself.

### R1: sign-in flooding (fixed for the LAN; remote residual)

Budgets for internet and for local/private peers are now separate, IPv6 is counted per
/64, and the internet sign-in budget is 600 per minute. A flood from the internet can no
longer affect LAN or VPN devices.

**Remaining:** a flood from more than 60 internet sources, or 60 IPv6 /64s, can still
block **remote** approved-device sign-in while it lasts. Guessing remains impossible
(256-bit secret), and `scrypt` work stays capped at 4 jobs. Filtering at an upstream edge
is the remaining control (F7).

### R7: certificate identity (partly fixed)

With remote access on, the generated certificate names the public hosts and omits the PC's
hostname. It still lists local IPs, which LAN and VPN devices use.

The change applies when the certificate is next issued: when a public name is added, on
renewal, or through the host's regenerate action. A `provided` certificate that names only
the public host avoids the rest.

### Residuals from earlier findings

- **F1:** 8-character codes (about 40 bits) remain a usability trade-off.
  - Bounded guessing is still possible.
  - A code stolen before it expires still works.
  - Using up the per-generation budget can block legitimate entry until a new code is
    issued.
  - Codes are LAN and private only.
- **F2:** an input message already queued in the native worker may still land before the
  worker acknowledges denial or the peer is torn down. The hardware revoke-timeout path
  has not been exercised.
- **F3:**
  - Explicit `tls-mode off` serves plaintext LAN admission.
  - Certificate enrolment over LAN HTTP needs an independent fingerprint check.
- **F5:** the IndexedDB device secret plus the password can be copied and used whenever the
  identity has no live session. One-session enforcement also lets a thief occupy the slot.
  A passkey (WebAuthn) challenge is the proposed stronger model.
- **F7:** in-process limits don't absorb volumetric TCP, TLS or UDP floods. That needs an
  upstream edge and real-network load tests.

## Recommended next steps

1. **Validation (R8):**
   - a phone on mobile data through a real router, on IPv4 and IPv6;
   - a packet capture showing no ICE checks toward client-chosen internal addresses.
2. **Host UI:** built. It needs a Windows build and the navigation test run on the owner's
   machine; see the verification record.
3. **R4:** track native dependency versions in packaging. Longer term, a lower-privilege
   media worker.
4. **F5:** a passkey (WebAuthn) challenge for approved devices, if a stronger
   remote-identity model is wanted.
5. **Support position:** only after step 1 passes should SECURITY.md stop recommending a
   VPN. An external penetration test is advisable before advertising internet use.

## Verification record

- **2026-09-25, `claude/remote-access-on-main`:**
  - `npm test` 851/851 and `npm run format:check` clean, on Linux, after the R-series
    fixes.
  - HTTPS regressions play an internet client against a real TLS listener:
    - remote-off refusal, HTTPS-only, refused code/enrolment routes;
    - HSTS, public names and public port;
    - the approval label and remote approved sign-in;
    - SDP answer rewriting and offer candidate filtering.
  - Unit tests cover:
    - split admission budgets and IPv6 /64 grouping (R1);
    - the `approved-only` requirement in settings and the CLI (R2);
    - offer filtering (R3), carrier-NAT classification (R5);
    - internet-session disconnect (R6), certificate names (R7);
    - the native port-range parser, compiled with g++ on Linux.
  - The R1 probe drove `AdmissionBudget` directly before the fix.
- **2026-09-25, owner's Windows machine, `npm run test:hardware`:** 14 of 17 passed,
  including real hardware encoding (Media Foundation H.264, H.265 and AV1), the native
  session and the probe.
  - The 3 failures were tests left behind by earlier `main` changes, not product defects:
    - the adapter-affinity test didn't map Media Foundation's `mf*` element names to their
      backend;
    - the desktop-host test expected letters-only codes, from before the letters-and-digits
      alphabet;
    - the host-status test still used the removed `/api/connect`, and ran against the
      owner's real settings, where HTTPS is active.
  - All three are fixed. The system tests now run with a throwaway `%LOCALAPPDATA%` with
    HTTPS off, so they never touch the user's settings.
  - That run didn't exercise the media port range: the new worker test and
    `media-ports-check.mjs` were added afterwards.
- **2026-09-25, second Windows run:** 16 of 18 passed, and all three earlier failures were
  fixed.
  - The new port-range test failed because the worker had not been rebuilt: the old binary
    ignores `VIDVNC_ICE_PORTS` and exits 0.
  - The host-status test still expected the pre-stream-runtime label "Connecting" for a
    session with no streams; it now expects "No active streams".
  - Every test run now brings its dependencies up to date first
    ([tools/dependencies.mjs](../../tools/dependencies.mjs)):
    - npm packages are reinstalled when they don't match the lockfile;
    - the hardware suite and the acceptance scripts rebuild a worker older than its
      sources;
    - the GStreamer SDK version is checked against the pinned 1.28.6.
- **2026-09-25, third Windows run: `npm run test:hardware` 18/18.**
  - The run rebuilt the stale worker by itself, including the port-range and ICE-TCP
    changes.
  - All 13 C++ unit tests passed, including `ice-ports`.
  - The real worker accepts a valid `VIDVNC_ICE_PORTS` range and exits with code 2 on a
    malformed one.
  - Hardware encoding (Media Foundation H.264, H.265, AV1), the native session and both
    host-pipe system tests passed.
  - `npm run test:host`: all 30 runtime-contract checks passed, including manifest
    validation, prerequisite checks and forced-owner process cleanup.
  - `media-ports-check.mjs` (Playwright 1.62.1, headless Chromium) passed:
    - 1 UDP candidate and 1 worker UDP socket, both inside 41000–41049;
    - no TCP listener;
    - the browser connected.
  - `npm audit --omit=dev`: 0 advisories (it doesn't cover GStreamer or other native
    binaries).
  - **Not run:** Windows host build, `npm run test:host`, native worker build, hardware
    tests, real router or public network, packet capture.
- **2026-09-24/25, `main` through `8308b55`** (from the earlier status notes):
  - `npm test` 816/816, `npm run format:check`, `npm run test:host`, Windows host build,
    the navigation exercise and `runtime-start-check.mjs` all passed.
  - Earlier Chromium fixtures covered key and approved sign-in, WebRTC, viewer controls,
    reconnect and layout; they were not rerun afterwards.
  - A manual browser check covered diagnostics capability handling before the listener
    was separated.

- **2026-09-25, Windows host remote access controls:**
  - Two build errors the owner reported are fixed: a name clash in the settings sender, and
    a crash on the server's `publicPort: null` (`JsonElement.TryGetInt32` throws on null).
  - The server side is covered by portable tests: the owner-gate modes and the start-mode
    rules (861/861).
  - **Not yet confirmed on Windows:**
    - the host build with the split-arrow indicator and offline settings;
    - the navigation test's new indicator checks.

## History

| Date       | Work                                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-09-23 | Baseline review found F1–F7. Remediation proposals defined SecRACs and deployment profiles. The owner selected interim hardening for F1, F2, F4, F5 and F7.                                                                                      |
| 2026-09-24 | Hardening on `main`: metered admission, purpose-neutral short-lived codes, revocation and one-session limit, diagnostics isolation, LAN-only HTTP and fail-closed TLS (F1–F5, F7). A re-review found F8 and the public-`Host` compatibility gap. |
| 2026-09-25 | Public login name and viewer assets only after admission (`main`, `90a37e4`). Remote access mode, the F8 fix, public names and port, media port range and public-address answers (`claude/remote-access-on-main`). Re-review found R1–R8.        |
| 2026-09-25 | R1, R3, R5 and R6 fixed. R2 contained by requiring `approved-only` and a required source-address check. R4 reduced (ICE-TCP off with a media range). R7 partly fixed (hostname omitted). R8 remains: hardware validation.                        |
| 2026-09-25 | Windows host remote access controls: local-only start by default, remote start from the sharing indicator, remote access shown on the indicator, Settings card usable while sharing is off, footer Stop sharing removed.                         |

The superseded documents were consolidated here on 2026-09-25. Their last versions can be
read with `git show 0215e44:docs/security/<file>`:

- `internet-exposure-review-2026-09-23.md`
- `internet-exposure-remediation-proposals-2026-09-23.md`
- `internet-exposure-review-2026-09-24.md`
- `internet-exposure-hardening-status-2026-09-24.md`
- `internet-exposure-review-2026-09-25.md`

The design specs and implementation plans for each hardening step are still in
`docs/superpowers/`.
