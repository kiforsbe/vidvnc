# Remote access: setting up VidVNC for devices on the internet

VidVNC can serve devices outside your local network without a third-party relay or VPN
service. The router forwards two things to the PC: the HTTPS port and a fixed range of
media ports. Remote access is **off by default**. While it is off, VidVNC refuses every
client with an internet source address.

This is new and has **not yet been validated on real networks or hardware** (see
[What has not been tested](#what-has-not-been-tested)). Until it has, the conservative
choice is a self-hosted VPN such as WireGuard, with remote access left off (see
[The alternative: a VPN](#the-alternative-a-vpn)).

## What changes when remote access is on

VidVNC decides whether a client is on the internet from the TCP connection's source
address ([peer-network.mjs](../../apps/server/src/peer-network.mjs)). It never uses a
header for this. These addresses are **not** the internet:

- private IPv4 (10/8, 172.16/12, 192.168/16)
- loopback and link-local
- IPv6 unique-local, and IPv6 addresses in one of this PC's own prefixes
- `100.64.0.0/10` **only while this PC has an adapter in that range**, for example
  Tailscale. Otherwise that range is an ISP's carrier-grade NAT, and its addresses are
  strangers.

| Client                         | Remote access off | Remote access on                                                                       |
| ------------------------------ | ----------------- | -------------------------------------------------------------------------------------- |
| This LAN                       | Unchanged         | Approved devices only (see below)                                                      |
| Private but not this LAN (VPN) | Unchanged         | Approved devices only (see below)                                                      |
| Internet                       | `403` for all     | HTTPS only; approved-device sign-in only; no codes, device setup, trust or diagnostics |

**Remote access requires connection mode `approved-only`, for everyone.** Remote mode
relies on the source address being genuine. If a router or program rewrites it (see
[Check the source address](#check-the-source-address)), an internet client looks local.
With `approved-only`, even then, the standing password and one-time codes don't work for
anyone. The most such a client could do is file a setup request that you would have to
approve.

For an internet client:

- **Sign-in is approved devices only.** `/api/key-start` is refused, so no 8-character
  code is accepted from the internet. Set up each device on the LAN first, then it signs
  in from anywhere with its device secret and password.
- **Its sign-in budget is separate.** Sign-in attempts from the internet have their own
  budget, so a flood from the internet can't lock out devices on the LAN or a VPN.
- **Keyboard and mouse still need approval.** A blanket `available` default still asks
  the host. Control starts without asking only if you set that approved device to
  `available`.
- **It learns less.** `/api/info` returns only the public name.
- **HSTS is sent** on the public names.
- **Media carries the router's public address.** The client's SDP answer names that
  address on the forwarded ports, with private LAN addresses removed. The client's offer
  keeps only candidates on public addresses, so it can't aim the PC's connection checks
  at machines on your LAN.
- **Switching remote access off** disconnects every internet session at once, with its
  streams and control.

## Setup

1. **Keep HTTPS on.** `tls-mode` must be `auto` (the default) or `provided`. With HTTPS
   off, internet devices can't connect, and the server log says so.
2. **Set approved-devices-only mode:**
   ```
   connection-mode approved-only
   ```
   `remote-access on` refuses to start without it, and the connection mode can't be
   changed back while remote access is on.
3. **Give the public name.** Use your DNS name (dynamic DNS is fine) and/or the router's
   public IP:
   ```
   public-hosts vnc.example.com
   ```
   - With remote access on, these names are accepted as HTTP `Host` values, get HSTS, and
     are added to the generated certificate.
   - The certificate then leaves out the PC's own name. It still lists local IPs, which
     LAN and VPN devices use. A `provided` certificate avoids that.
   - An `auto` certificate that doesn't name the public hosts yet is **reissued**, so every
     device must install the new certificate on the LAN again (step 6).
4. **Pick a media port range and forward it.** For example:
   ```
   media-ports 40000-40049
   ```
   - Choose 8 to 1000 ports; 50 is plenty for eight devices.
   - On the router, forward that range for **UDP** to this PC with the **same port
     numbers** outside and inside. VidVNC announces the public address with the same port
     numbers it uses locally, so a remapped port won't work.
   - With a range set, the worker offers UDP only (no ICE-TCP), so don't forward the range
     for TCP.
   - New streams use the range; streams already running keep their ports.
5. **Forward the HTTPS port.** Forward the TLS port (default `4383`, TCP) to this PC. If
   the router uses a different public port, usually 443 → 4383, tell VidVNC:
   ```
   public-port 443
   ```
   Without this, a browser that sends `vnc.example.com` (port 443) is refused with `421`.
6. **Set up devices on the LAN.**
   - Install the certificate from `/trust`, and check its fingerprint against the host
     screen.
   - Register the device with a setup code and approve it on the host. The approval
     screen shows where each request came from: _Local network_,
     _Private network (not this LAN)_ or _Internet_.
7. **Turn it on:**
   ```
   remote-access on
   ```
   All of these commands also work offline (`npm run config -- remote-access on`). The
   Windows host accepts `remoteAccess`, `publicHostnames`, `publicPort` and `mediaPorts`
   on its settings pipe, but has no screen for them yet.
8. **Check the source address** (next section). This step is required.

**Never forward:**

- the plain HTTP port (`4382`)
- the diagnostics port
- anything else on the PC

Don't put a reverse proxy, `netsh portproxy`, or WSL/Hyper-V port forwarding in front of
VidVNC.

**Windows Firewall** must allow the media worker to receive on the media range. If
Windows asks when the first stream starts, allow it on the network profile your LAN uses.

## Check the source address

Some routers source-NAT forwarded connections, and so does forwarding software on the PC.
The client then appears to come from the router's LAN address instead of its own, and
every remote-mode rule that depends on "is this the internet?" is wrong for it.
`approved-only` mode limits the damage, but the setup is still wrong.

To check:

1. Turn Wi-Fi off on a phone, so it uses mobile data.
2. Sign in to VidVNC from the phone.
3. Look at the host's session list (or `sessions` in the CLI). The phone's address must be
   a **public** address.

If it shows your router's LAN address (for example `192.168.1.1`), change the router's
port-forward settings, or use a VPN instead.

## Limits you should know

The [security analysis](internet-exposure.md) lists what is still open. In short:

- **Device credentials can be copied.** An approved device's secret lives in the browser.
  Someone with that secret **and** the password can sign in as that device. Use a strong
  password, and remove devices you've lost.
- **Denial of service.** An internet flood can still use up the internet sign-in budget,
  which blocks remote devices for as long as it lasts, but it can't lock out the LAN. Large
  distributed floods need filtering upstream.
- **The media ports face the internet while a stream is live.** Anyone can send packets
  to them. They are only processed as ICE connectivity checks until the client proves it
  holds the credentials from the signed-in session.
- **CGNAT.** If your ISP gives the router no public IPv4 address, port forwarding can't
  work. Use IPv6 if the ISP offers it. Otherwise, a small VPS you control (running
  WireGuard, or your own TURN server) is the cheapest option you still run yourself.

## What has not been tested

- The server logic is covered by the portable test suite: classification, HTTPS-only,
  refused routes, HSTS, public names and port, answer rewriting and offer filtering,
  budgets, the connection cap, the control default, and the session cleanup when remote
  access is switched off.
- **The native change has not been compiled or run.** It applies the port range and turns
  ICE-TCP off for each WebRTC peer through GStreamer's ICE agent properties, and a
  malformed range stops the worker.
- **No real router, public network, or client behind carrier NAT has been used.**

Before relying on it:

1. Run `npm run build:native`, then `npm run test:hardware` on Windows. It checks that the worker accepts a
   valid range and refuses to start with a malformed one.
2. Run the acceptance check, which connects headless Chromium through the worker with a
   range set. It asserts that every candidate is UDP inside the range, and uses `netstat`
   to confirm that every worker UDP socket is in the range and no TCP port is listening:
   ```
   node native/media-worker/tests/media-ports-check.mjs <path to playwright>
   ```
3. Connect from a phone on mobile data, which also covers the source-address check.

## The alternative: a VPN

WireGuard on the router or the PC exposes one UDP port and no VidVNC port at all. Remote
devices get private VPN addresses, which VidVNC treats as private, not internet. They
connect as they would on the LAN, except the standing password, which stays limited to
the physical LAN. Remote access can then stay off.
