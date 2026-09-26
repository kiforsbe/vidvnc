# Remote access: setting up VidVNC for devices on the internet

VidVNC can serve devices outside your local network without a third-party relay or VPN
service. The router forwards two things to the PC: the HTTPS port (TCP) and the one media
port (UDP, 4384 by default). Remote access is **off by default**. While it is off, VidVNC refuses every
client with an internet source address.

This is new and only **partly validated**: it passes on hardware and has streamed to an
iPhone through one real router, but it hasn't had a packet capture or an IPv6 run (see
[What has been tested](#what-has-been-tested)). Until it has, the conservative choice is a
self-hosted VPN such as WireGuard, with remote access left off (see
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
- **Media goes to the router's public address on the media port.** Every device's media,
  LAN and internet alike, goes through VidVNC's media relay on that one port
  ([media-relay.mjs](../../apps/server/src/media-relay.mjs)); the media worker itself listens
  on `127.0.0.1` only. An internet client's SDP answer names the public IPv4 addresses of the
  public names (and this PC's global IPv6 addresses) on the media port. The server removes
  every candidate from the client's offer, so the PC sends no connection checks of its own to
  anyone.
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
4. **Forward the media port.** It is UDP `4384` unless you change it:
   ```
   media-port 4384
   ```
   - On the router, forward that port for **UDP** to this PC with the **same port number**
     outside and inside. VidVNC announces the public address with the port it uses locally,
     so a remapped port won't work. Don't forward it for TCP.
   - If you forwarded a range for an earlier version, VidVNC now uses the range's first port
     (`media-ports` still sets it, and says it is deprecated); remove the rest of the range
     from the router.
   - Changing the port restarts the media relay and stops streams that are running; devices
     reconnect.
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
   - **Carry the device key to the remote address.** A browser keeps saved data separately
     for each address, so a key saved at `https://192.168.x.x:4383` doesn't exist at
     `https://vnc.example.com`. Once a public name is set, the sign-in page on the LAN
     shows **Open remote address** and **Copy link** under "To sign in from the internet":
     - **Open** works if your router lets devices at home reach the public address (NAT
       loopback).
     - **Copy link** lets you open the link later in the same browser while you are away.

     The link carries the key in the part after `#`, which browsers never send to a server.
     The page that opens stores the key and removes it from the address bar. It never
     replaces a different key already stored there. Keep the link to yourself: with it,
     someone only needs your password.

     **iPhone Home Screen:** VidVNC can be added to the Home Screen (Share → Add to Home
     Screen), where it opens without Safari's bars. iOS keeps a Home Screen app's saved data
     separate from Safari's, so set the device up from the Home Screen app itself, on the
     LAN, rather than in Safari.
7. **Turn it on.**
   - **In the Windows host app:**
     - Steps 3–5 (public names, media port and public port) are under
       **Settings → Remote access**. You can fill them in and save while sharing is off;
       saving never turns remote access on. Step 2 happens for you: turning remote access
       on also switches to approved-devices-only.
     - Then either select **Start with remote access** (or **Turn on**, while sharing) there,
       or open the arrow on the **sharing indicator**
       at the bottom of the navigation pane and choose **Start sharing with remote access**.
     - Clicking the indicator itself starts sharing on the local network only, or stops
       sharing. Each start is local-only unless you choose remote.
     - While remote access is on, the indicator shows a globe and **Remote access on**.
   - **From the CLI:**
     ```
     remote-access on
     ```
     All of these commands also work offline (`npm run config -- remote-access on`).
8. **Check the source address** (next section). This step is required.

**Never forward:**

- the plain HTTP port (`4382`)
- the diagnostics port
- anything else on the PC

Don't put a reverse proxy, `netsh portproxy`, or WSL/Hyper-V port forwarding in front of
VidVNC.

**Windows Firewall** must allow the media relay to receive on the media port. The relay runs
in VidVNC's Node.js, so when sharing first starts Windows may ask about Node.js: allow it on
the network profile your LAN uses. The media worker no longer needs a firewall exception.

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
- **The media port faces the internet while sharing.** Anyone can send packets to it. The
  relay, written in JavaScript, checks each one and forwards nothing until the sender proves
  it holds the ICE password of a stream just given to a signed-in device; it never replies to
  anyone else. After that, DTLS and media packets from that exact address and port reach the
  media worker's native code, which is not yet sandboxed.
- **CGNAT.** If your ISP gives the router no public IPv4 address, port forwarding can't
  work. Use IPv6 if the ISP offers it. Otherwise, a small VPS you control (running
  WireGuard, or your own TURN server) is the cheapest option you still run yourself.

## What has been tested

- The server logic is covered by the portable test suite: classification, HTTPS-only,
  refused routes, HSTS, public names and port, answer rewriting and offer filtering,
  budgets, the connection cap, the control default, and the session cleanup when remote
  access is switched off.
- The media relay is covered by the portable suite: STUN parsing and message-integrity
  checks against the RFC 5769 vectors, pinning, budgets, expiry, and the process protocol.
  Headless Chromium connected through a prototype of the relay on Windows at 1080p60 (gates
  P1 and P2 in the [implementation plan](../superpowers/plans/2026-09-26-r4-media-relay-and-privilege-split.md)).
- An iPhone at a public address signed in and streamed through a real router with the
  earlier port range, and the host showed its public address.
- **Not yet:** the relay built into VidVNC, end to end on Windows with real browsers and an
  iPhone, including iCloud Private Relay; a packet capture; an IPv6 run; a client behind
  carrier NAT.

To check your own setup:

1. Run `npm run test:hardware` on Windows (it rebuilds the worker first if it is out of
   date).
2. Run the relay acceptance check, which connects headless Chromium through the relay
   core and a loopback-only worker, and uses `netstat` to confirm the worker has no socket
   outside `127.0.0.1`:
   ```
   node native/media-worker/tests/relay-check.mjs <path to playwright>
   ```
3. Connect from a phone on mobile data, which also covers the source-address check. Type
   `media-relay` in the CLI to see the authenticated media paths and dropped datagrams.

## The alternative: a VPN

WireGuard on the router or the PC exposes one UDP port and no VidVNC port at all. Remote
devices get private VPN addresses, which VidVNC treats as private, not internet. They
connect as they would on the LAN, except the standing password, which stays limited to
the physical LAN. Remote access can then stay off.
