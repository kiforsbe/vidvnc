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

**Remote access is not yet ready to rely on.**

1. An outsider can cheaply **lock every approved device out of sign-in** (R1, confirmed).
2. The remote-mode boundary depends on **the source address being genuine**. A router or
   program that source-NATs forwarded connections turns the internet into the LAN (R2).
3. The **media path is untested on hardware**, and its forwarded ports expose native ICE
   parsing before authentication (R3, R4, R8).

Until those are closed and exercised, the recommended way to reach VidVNC from outside is a
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
   (UDP, optionally TCP), with the same port numbers outside and inside for the media
   range. Never forward the plaintext HTTP port or the diagnostics port.
2. **No same-host reverse proxy, port proxy or NAT that rewrites the client's source
   address.** The client's real source address must reach VidVNC (see R2).
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

| Profile                                                  | Status                                          | What it needs                                                                      | Trade-off                                                                                                                                                                           |
| -------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Self-hosted VPN** (WireGuard, Tailscale)               | **Recommended now**                             | A VPN endpoint on the router or PC; remote access stays off                        | One UDP port exposed and no VidVNC port. VPN clients count as private and use the ordinary rules, except the standing password, which stays LAN-only. Every viewer needs VPN setup. |
| **Direct port forwarding** (`remote-access on`)          | **Implemented, not yet validated** (R1–R8 open) | Public name or IP, HTTPS port and media range forwarded, devices set up on the LAN | No relay and no third party. Media depends on the router and the client's network, and the native ICE stack faces the internet (R4).                                                |
| Owner-run TURN relay (for example coturn on a small VPS) | Not implemented                                 | A public host the owner controls                                                   | Works behind carrier-grade NAT and restrictive networks; needs relay-only ICE and short-lived credentials on both peers.                                                            |
| Product-operated outbound relay                          | Not selected                                    | A hosted rendezvous and TURN service                                               | No router setup, but it is a new hosted service with its own trust, cost and security review.                                                                                       |

A profile never makes authentication optional. A degraded remote configuration must refuse
internet clients rather than fall back to plaintext or to an unintended route.

## Current exposure map

| Surface                          | Remote access off                                                                                     | Remote access on (internet client)                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| HTTP `4382`                      | Binds loopback and eligible Private-LAN addresses only                                                | Same; an internet peer that still reached it gets `403`                                                                |
| HTTPS `4383`                     | Binds `0.0.0.0`; internet peers get `403` for every route                                             | Public login shell, `/api/info` (public name only), approved-device sign-in and claim status; HSTS on the public names |
| `/api/key-start` (all codes)     | Local and private peers only                                                                          | `403`; no code budget is consumed                                                                                      |
| Viewer assets (`/viewer/…`)      | After admission, with a session- and peer-bound `HttpOnly` cookie                                     | Same                                                                                                                   |
| Session and signaling APIs       | Bearer bound to the socket address                                                                    | Same; SDP answers carry the public address on the media ports, with private addresses removed                          |
| Certificate enrolment (`/trust`) | Local peers only                                                                                      | `403`                                                                                                                  |
| Diagnostics                      | `404` on the main ports; separate `127.0.0.1` listener with an owner-issued 256-bit, 15-minute bearer | Same                                                                                                                   |
| Media ports                      | Random ephemeral ports, LAN only                                                                      | Fixed `media-ports` range; reachable by anyone while a stream is live (R4)                                             |
| Owner management                 | No HTTP route; host pipe and local CLI only                                                           | Same                                                                                                                   |

Clients count as **local** when they are on an eligible Private physical LAN. That decides
the standing password and certificate enrolment.

**Private** clients are not on this LAN but not the internet either:

- a VPN, loopback, link-local, or carrier-grade NAT (100.64.0.0/10) address;
- an IPv6 unique-local address, or an address in one of this PC's IPv6 prefixes.

Private clients follow the ordinary rules. **Internet** clients are everyone else; an
unknown address fails closed as internet.

## Controls in place

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
- For internet clients, the answer replaces private host candidates with the public IPv4 on
  the same ports and removes private addresses.
- The worker applies the `media-ports` range to every WebRTC peer and refuses to start with
  an invalid range.

## Findings register

Severity reflects an internet-exposed server under the assumptions above. The **F** findings
come from the 2026-09-23 and 2026-09-24 reviews; the **R** findings come from the 2026-09-25
review of the remote access mode.

| ID  | Finding                                                                       | Severity (at discovery) | Status                                                                   |
| --- | ----------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------ |
| R1  | One global sign-in budget lets anyone lock all approved devices out           | High (availability)     | **Open, confirmed**                                                      |
| R2  | Source-NAT on forwarded connections makes internet clients local              | Medium (conditional)    | **Open**                                                                 |
| R3  | Client-supplied ICE candidates reach the worker unfiltered                    | Medium                  | **Open**                                                                 |
| R4  | Native ICE/STUN parsing is reachable before authentication on the media ports | Medium (residual)       | **Open**, inherent to direct WebRTC                                      |
| R5  | 100.64.0.0/10 is treated as private                                           | Low (conditional)       | **Open**                                                                 |
| R6  | Turning remote access off leaves internet sessions running up to 20 s         | Low                     | **Open**                                                                 |
| R7  | The generated certificate lists the PC's name and local IPs                   | Low (disclosure)        | **Open**                                                                 |
| R8  | The native media port range is not compiled or run                            | Assurance gap           | **Open**                                                                 |
| F1  | Connection-key guessing and a key-validity oracle bypassed the rate limit     | High                    | Mitigated; the 8-character code trade-off remains (LAN and private only) |
| F2  | `view-only` changes didn't revoke captured automatic control                  | High                    | Mitigated; a short asynchronous native window remains                    |
| F3  | HTTPS could degrade to HTTP; enrolment was plaintext                          | High                    | Fixed; LAN enrolment still needs a fingerprint check                     |
| F4  | A loopback proxy could expose diagnostics                                     | Medium                  | Fixed                                                                    |
| F5  | An approved-device credential is copyable                                     | Medium                  | Accepted model with mitigations; not device binding                      |
| F6  | Direct WebRTC had no remote network policy                                    | Medium                  | Implemented (port range, public-address answers); untested (R3, R4, R8)  |
| F7  | Limits could be exhausted; some state had no lifetime                         | Medium                  | Mostly fixed; R1 and volumetric floods remain                            |
| F8  | A remote registration was labelled "Local network"                            | Medium (misleading cue) | Fixed                                                                    |
| —   | Public DNS names and routers' public ports were refused (`403`/`421`)         | Compatibility           | Fixed (`public-hosts`, `public-port`)                                    |
| —   | No opt-in remote mode                                                         | Design gap              | Fixed (`remote-access`, off by default)                                  |

## Open findings

### R1: one sign-in budget for the whole server lets anyone lock approved devices out (confirmed)

[`AdmissionBudget`](../../apps/server/src/admission-budget.mjs) allows 120 sign-in and
registration attempts per minute for the whole server, and 10 per source.

- **IPv4:** 12 addresses sending junk sign-ins use up the whole budget. Every approved
  device, on the LAN too, then gets `429` for as long as the flood continues.
- **IPv6:** source addresses aren't grouped by /64, so one attacker cycling through their
  own /64 is enough if HTTPS listens on IPv6.
- **Claim polling:** the claim-status budget (600 per minute) can be used up the same way.

A probe against the class confirmed both cases. Nobody can get in this way: sign-in needs
the 256-bit secret, and `scrypt` is already capped. This is the cheapest denial of service
against an exposed server.

**Fix:**

- Group IPv6 by /64.
- Keep separate budgets for internet peers and for local/private peers.
- Raise the global sign-in limit. The `scrypt` cap already bounds CPU, and `scrypt` only
  runs after the secret matches.

### R2: the remote-mode boundary trusts the source address

Every remote-mode rule is keyed to the TCP source address:

- refusing the internet while remote access is off;
- approved-device-only sign-in for internet clients;
- local-only codes, setup and enrolment;
- no automatic control for internet sessions;
- the approval label.

Some routers source-NAT inbound port forwards: some ISP routers, NAT reflection, and
`netsh portproxy`/WSL/Hyper-V forwarding or a reverse proxy on the PC. Internet clients
then arrive from a private address, often the router's LAN address, and are treated as
local. They can then use:

- the standing password (in `session-key` mode), one-time and setup codes;
- certificate enrolment;
- the "Local network" label;
- automatic control under an `available` default.

Remote access makes this more likely, because the operator has, by definition, forwarded
ports.

**Fix:**

- While remote access is on, require `approved-only` connection mode. A laundered source
  can then do no more than submit a setup request for the owner to approve.
- Make the guide's mobile-data check mandatory: the host's session list must show a public
  address.
- Optionally warn when every HTTPS session comes from the router's address.

### R3: client-supplied ICE candidates reach the worker unfiltered

The browser's offer is forwarded to the worker unchanged, and `webrtcbin` runs connectivity
checks toward every candidate in it.

- A signed-in internet client can make the host send STUN checks, and ICE-TCP attempts, to
  arbitrary LAN hosts and ports.
- Candidates that are hostnames may trigger DNS lookups (unconfirmed).
- The impact is limited LAN probing from inside the network.

**Fix:** for internet sessions, remove private, link-local, `.local` and hostname candidates
from the offer. The browser uses `iceServers: []`, so it only has host candidates, which
are useless from the internet anyway. The host still learns the real address from the
client's incoming checks (a peer-reflexive candidate).

### R4: native parsing is reachable before authentication on the media ports

While a stream is live, anyone can send UDP (and connect over ICE-TCP) to the forwarded
range. libnice parses STUN before it checks message integrity. DTLS and the input data
channel follow only after ICE succeeds with credentials from the authenticated signaling.

No defect is known. The exposure is native parsing in an unsandboxed process that can
inject input.

**Fix:**

- Keep GStreamer and libnice current, and scan them separately from `npm audit`.
- Consider turning ICE-TCP off unless it's requested.
- Longer term, a lower-privilege worker with a narrow input broker.

### R5: carrier-grade NAT addresses count as private

`100.64.0.0/10` is treated as private so that Tailscale-style overlays work. On ISPs that
let customers behind the same carrier-grade NAT reach each other, a neighbour who reaches a
forwarded port counts as private:

- remote-off doesn't refuse them;
- one-time and setup codes are accepted from them (the standing password is not).

**Fix:** treat that range as private only while this PC has an adapter in it.

### R6: turning remote access off doesn't end internet sessions at once

Requests from internet sessions are refused as soon as remote access is off. Their
sessions, streams and any control lease end when the 20-second session TTL lapses.

**Fix:** disconnect internet sessions when remote access is switched off.

### R7: the certificate lists local identity

The generated certificate names the PC's hostname and every local IP, as well as the public
names. Any client that reaches the HTTPS port can read them.

**Fix:** while remote access is on, issue the certificate for the public names plus only the
LAN names that are actually used, or recommend a `provided` certificate.

### R8: the media path is untested

The worker's `min-rtp-port`/`max-rtp-port` handling is not compiled or run. It is also not
known whether libnice applies the range to ICE-TCP.

A failure fails safe: the worker picks ports outside the forwarded range, and media fails.

**Before release:** run the Windows build and `npm run test:hardware`, confirm the worker's
sockets stay inside the range with `netstat -ano -p udp`, and connect from mobile data.

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

1. **Code fixes, small (R1, R3, R5, R6):**
   - IPv6 /64 grouping and split budgets in `AdmissionBudget`;
   - candidate filtering for internet sessions;
   - a CGNAT rule that depends on a local adapter;
   - disconnecting internet sessions when remote access is switched off.
2. **R2:** require `approved-only` while remote access is on, and make the mobile-data
   source check a setup step.
3. **R7:** trim the certificate's names while remote access is on.
4. **R4:** decide on ICE-TCP, and start tracking native dependency versions.
5. **Validation (R8):**
   - Windows host build and `npm run test:host`;
   - native worker build and `npm run test:hardware`;
   - `netstat` checks of the media range;
   - a phone on mobile data through a real router, on IPv4 and IPv6;
   - a packet capture showing no ICE checks toward client-chosen internal addresses once
     R3 is fixed.
6. **Host UI:** a screen for `remote-access`, `public-hosts`, `public-port` and `media-ports`.
   Today they are set through the CLI, or the host's settings pipe, which has no UI.
7. **Support position:** only after steps 1–5 pass should SECURITY.md stop recommending a
   VPN. An external penetration test is advisable before advertising internet use.

## Verification record

- **2026-09-25, `claude/remote-access-on-main`:**
  - `npm test` 843/843 and `npm run format:check` clean, on Linux.
  - HTTPS regressions play an internet client against a real TLS listener: remote-off
    refusal, HTTPS-only, refused code/enrolment routes, HSTS, public names and public port,
    the approval label, remote approved sign-in, and SDP answer rewriting.
  - The R1 probe drove `AdmissionBudget` directly.
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

## History

| Date       | Work                                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-09-23 | Baseline review found F1–F7. Remediation proposals defined SecRACs and deployment profiles. The owner selected interim hardening for F1, F2, F4, F5 and F7.                                                                                      |
| 2026-09-24 | Hardening on `main`: metered admission, purpose-neutral short-lived codes, revocation and one-session limit, diagnostics isolation, LAN-only HTTP and fail-closed TLS (F1–F5, F7). A re-review found F8 and the public-`Host` compatibility gap. |
| 2026-09-25 | Public login name and viewer assets only after admission (`main`, `90a37e4`). Remote access mode, the F8 fix, public names and port, media port range and public-address answers (`claude/remote-access-on-main`). Re-review found R1–R8.        |

The superseded documents were consolidated here on 2026-09-25. Their last versions can be
read with `git show 0215e44:docs/security/<file>`:

- `internet-exposure-review-2026-09-23.md`
- `internet-exposure-remediation-proposals-2026-09-23.md`
- `internet-exposure-review-2026-09-24.md`
- `internet-exposure-hardening-status-2026-09-24.md`
- `internet-exposure-review-2026-09-25.md`

The design specs and implementation plans for each hardening step are still in
`docs/superpowers/`.
