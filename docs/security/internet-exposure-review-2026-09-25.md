# Internet exposure security review, 2026-09-25

Reviewed on branch `claude/remote-access-on-main` at `6021688`. That is `main` at `90a37e4`
plus the opt-in remote access mode, the fixed media ports and SDP address rewriting. This is
a source review with targeted probes, not a penetration test. It supersedes the
[2026-09-24 review](internet-exposure-review-2026-09-24.md) for this branch; that review and
the [2026-09-23 baseline](internet-exposure-review-2026-09-23.md) remain the history.

**Scenario:** remote access is on, and the operator has followed the
[remote access guide](remote-access.md). Only the HTTPS port and the media port range are
forwarded, straight to the PC, with no proxy.

## Bottom line

No confirmed way was found for an unauthenticated internet client to see the screen, send
input or reach owner management. Internet admission is now approved-device sign-in only,
over HTTPS only, and nothing is served to the internet while remote access is off.

**Remote access should not be relied on yet**, for three reasons:

1. An outsider can cheaply **lock every approved device out of sign-in** (R1, confirmed).
2. The whole remote-mode boundary rests on the **source address**. A router or program that
   rewrites it quietly turns the internet into the LAN (R2).
3. The **media path has not been run on real hardware**. Once the media ports are
   forwarded, the native ICE stack faces the internet before any authentication (R3, R4, R8).

R1 and R3 are small code fixes; R2 needs a small code change and a setup check.

## Findings

Severity is for an internet-exposed server in the scenario above.

| #   | Finding                                                                       | Severity             | Status                               |
| --- | ----------------------------------------------------------------------------- | -------------------- | ------------------------------------ |
| R1  | One global sign-in budget: anyone can lock all approved devices out           | High (availability)  | **Confirmed** by probe               |
| R2  | Source-NAT on inbound forwards makes internet clients "local"                 | Medium (conditional) | Design limit; router-dependent       |
| R3  | Client-supplied ICE candidates reach the worker unfiltered                    | Medium               | Confirmed in code; impact unmeasured |
| R4  | Native ICE/STUN parsing is reachable before authentication on the media ports | Medium (residual)    | Inherent to direct WebRTC            |
| R5  | 100.64.0.0/10 (carrier-grade NAT) is treated as private, not internet         | Low (conditional)    | Confirmed in code                    |
| R6  | Turning remote access off leaves internet sessions running for up to 20 s     | Low                  | Confirmed in code                    |
| R7  | The generated certificate lists the PC's name and local IPs                   | Low (disclosure)     | Carried over; now internet-visible   |
| R8  | The native media port range is not compiled or run                            | Assurance gap        | Untested                             |

Carried over unchanged from the 2026-09-24 review:

- **F5:** an approved browser's secret can be copied.
- **F2:** native revocation has a short asynchronous window.
- **F7:** in-process limits don't stop volumetric floods.
- **Enrolment:** installing the certificate over LAN HTTP needs a fingerprint check.

### R1: one sign-in budget for the whole server lets anyone lock approved devices out (confirmed)

[`AdmissionBudget`](../../apps/server/src/admission-budget.mjs) allows 120 sign-in and
registration attempts per minute **for the whole server**, and 10 per source address.

- **IPv4:** 12 addresses sending junk sign-ins use up the whole budget. After that,
  every approved device is refused with `429` for as long as the flood continues,
  including devices on the LAN.
- **IPv6:** source addresses are not grouped by /64. If the HTTPS listener is bound to
  IPv6, one attacker cycling through their own /64 is enough.
- **Claim polling:** the separate claim-status budget (600 per minute) can be used up the
  same way, blocking new devices from collecting their credential.

A probe against the real class confirmed this: 12 IPv4 sources × 10 attempts were all
accepted, and then both an internet device and a LAN device were refused. A single IPv6
/64 did the same with 120 addresses.

No guess can succeed: sign-in needs the 256-bit device secret. This is purely a denial of
service, and it is the cheapest one available against an exposed server.

**Fix:**

- Group IPv6 sources by /64.
- Give internet peers and local/private peers separate budgets, so an internet flood can't
  lock out the LAN.
- Raise the global sign-in limit. Password-hashing work is already bounded by the
  four-job `scrypt` cap, and `scrypt` only runs after the device secret matches, so the
  global limit doesn't protect the CPU.

### R2: the remote-mode boundary trusts the source address

Every remote-mode rule keys on the TCP source address
([`peer-network.mjs`](../../apps/server/src/peer-network.mjs), `localSessionScope`):

- refusing the internet while remote access is off;
- approved-device-only sign-in for internet clients;
- local-only codes, device setup and certificate enrolment;
- no automatic control for internet sessions;
- the approval label.

Some routers source-NAT inbound port forwards: some ISP-supplied routers, some NAT
reflection setups, and `netsh portproxy`/WSL/Hyper-V forwarding on the PC itself. A
same-host reverse proxy does the same. Then every internet client arrives from a private
address, often the router's LAN address, which VidVNC classifies as local. That client can:

- use the **standing password** (if the connection mode allows it), one-time codes and setup codes;
- reach the certificate pages;
- appear as "Local network" in the approval screen;
- get automatic control under an `available` default.

The 2026-09-24 review listed this as a conditional configuration risk. Remote mode makes it
matter more, because an operator who turns on remote access has, by definition, forwarded
ports.

**Fix:**

- While remote access is on, require `approved-only` connection mode. This removes the
  standing password and one-time codes for everyone, so a laundered source can at most
  submit a setup request for the owner to approve.
- Add a setup check to the guide: connect once from mobile data and confirm the host's
  session list shows a public address.
- Optionally, have the host warn when every HTTPS session arrives from the router's address.

### R3: client-supplied ICE candidates are passed to the worker unfiltered

The browser's SDP offer is forwarded to the worker as-is, and `webrtcbin` runs connectivity
checks toward every candidate in it. A signed-in internet client can put any address in its
offer. The host would then send STUN checks, and ICE-TCP connection attempts, to hosts and
ports on your LAN. Candidates that are hostnames may make the host run DNS lookups
(unconfirmed).

The impact is limited to LAN probing: the traffic is STUN, and all the client sees is
whether ICE succeeded. It still lets an outside account aim traffic from inside your
network.

**Fix:** for internet sessions, strip every candidate from the offer that is private,
link-local, `.local`, or a hostname. The browser uses `iceServers: []`, so it only has host
candidates, which are useless from the internet anyway. The host still learns the client's
real address from its incoming checks (a peer-reflexive candidate). Two lines, reusing
`isPrivateAddress`.

### R4: native parsing is reachable before authentication on the media ports

With the media range forwarded, anyone on the internet can send UDP (and, with ICE-TCP,
connect over TCP) to the worker's sockets while a stream is live. libnice parses the STUN
message before it checks the message's integrity. DTLS, and the input data channel after
it, are only reached after ICE succeeds with credentials from the authenticated signalling.

No defect is known. This is exposure of the native parser, in an unsandboxed process that
can inject input.

**Fix:**

- Keep GStreamer and libnice current in packaging.
- Consider turning ICE-TCP off unless an operator asks for it; that halves the surface.
- Longer term, a lower-privilege worker.

### R5: carrier-grade NAT addresses count as private

`100.64.0.0/10` is treated as not internet, so VPN overlays such as Tailscale keep working.
Some ISPs let customers behind the same carrier-grade NAT reach each other. On those
networks, a neighbour who reaches a forwarded port is treated like a VPN client:

- remote access being off doesn't refuse them;
- one-time and setup codes are accepted from them (the standing password is not).

**Fix:** treat 100.64.0.0/10 as private only while this PC has an adapter in that range
(which is the case with Tailscale).

### R6: turning remote access off doesn't end internet sessions at once

Requests from internet sessions are refused as soon as remote access is off. The sessions
themselves, their streams and any control lease end only when the 20-second session TTL
lapses.

**Fix:** disconnect internet sessions when remote access is switched off.

### R7: the certificate lists local identity

The automatically generated certificate names the PC's hostname and every local IP,
alongside the public names. With remote access on, any internet scanner of the HTTPS port
can read them. A `provided` certificate avoids this.

**Fix:** while remote access is on, issue the certificate for the public names plus only
the names the LAN actually uses.

### R8: the media path is untested

The worker's `min-rtp-port`/`max-rtp-port` handling is not compiled or run. It is not known
yet whether libnice applies the range to ICE-TCP as well as UDP.

A failure here fails safe: the worker picks ports outside the forwarded range and media
fails. It doesn't make anything less secure.

**Before release:** run it on Windows, check the sockets with `netstat`, and connect from a
phone on mobile data.

## Resolved since the 2026-09-24 review (this branch)

- **No remote mode → opt-in remote access.** Internet peers get `403` for everything while
  it is off. While it is on, they are HTTPS-only, can't use `/api/key-start` (so no
  8-character code is accepted from the internet), and trust/diagnostics stay local.
- **F8 → fixed.** The approval label comes from the registering peer.
- **Public `Host` → fixed.** Public names are accepted, get HSTS, and are added to the
  certificate. `public-port` fixes the `421` for routers that forward 443 to the TLS port.
- **F6 (design) → implemented, untested.** A fixed ICE port range, plus the public address
  in answers for internet clients, with private addresses removed. See R3, R4 and R8 for
  what remains.
- **Automatic control → fixed.** A blanket `available` default no longer gives an internet
  session automatic control.
- **F7 (connection slots) → partly fixed.** There is now a cap of 12 connections per
  source per listener.

## Checked and sound

Checked on this branch and found sound, without re-deriving the 2026-09-24 review:

- **Route order.** The internet gate runs before the Host check. Refused internet requests
  never reach the admission budgets, and `/api/key-start` is refused before any code
  budget is used.
- **Host and Origin checks.** A public name counts only while remote access is on, and the
  public port only for public names. `Origin` must match `Host` including the port.
- **Session binding.** The bearer is bound to the socket address. The viewer cookie is
  `HttpOnly`, `SameSite=Strict`, `Secure` on HTTPS, and bound to the peer and session.
- **Sign-in.** `scrypt` runs only after the 256-bit secret matches, and at most four run at
  once.
- **Worker commands.** The worker's stdin carries JSON built with `JSON.stringify`, so client
  SDP can't inject commands.
- **Page content.** The web client uses `innerHTML` only for its own static viewer fragment
  and icons.
- **Registrations.** Registration strings reject control characters.
- **Dependencies.** `npm audit --omit=dev` reports 0 vulnerabilities. That does not cover
  GStreamer, libnice or other native binaries.

## Verification

- `npm test`: 843/843, and `npm run format:check`: clean, on Linux at `6021688`.
- The R1 probe drove `AdmissionBudget` directly with 12 IPv4 sources and one IPv6 /64.
- Not run: Windows host build, `npm run test:host`, native worker build, hardware tests, a
  real router, a public network, or packet capture.
