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
- CGNAT/overlay VPN addresses (100.64/10, which Tailscale uses)
- IPv6 unique-local, and IPv6 addresses in one of this PC's own prefixes

| Client                         | Remote access off | Remote access on                                                                       |
| ------------------------------ | ----------------- | -------------------------------------------------------------------------------------- |
| This LAN                       | Unchanged         | Unchanged                                                                              |
| Private but not this LAN (VPN) | Unchanged         | Unchanged                                                                              |
| Internet                       | `403` for all     | HTTPS only; approved-device sign-in only; no codes, device setup, trust or diagnostics |

For an internet client:

- **Sign-in is approved devices only.** `/api/key-start` is refused, so no 8-character
  code (standing password, one-time code or setup code) is accepted from the internet.
  Set up each device on the LAN first, then it signs in from anywhere with its device
  secret and password.
- **Keyboard and mouse still need approval.** A blanket `available` default still asks
  the host. Control starts without asking only if you set that approved device to
  `available`.
- **It learns less.** `/api/info` still returns only the public name.
- **HSTS is sent** on the public names.
- **Media carries the router's public address.** The client's SDP answer names that
  address on the forwarded ports, and private LAN addresses are removed from it.

## Setup

1. **Keep HTTPS on.** `tls-mode` must be `auto` (the default) or `provided`. With HTTPS
   off, internet devices can't connect, and the server log says so.
2. **Give the public name.** Use your DNS name (dynamic DNS is fine) and/or the router's
   public IP:
   ```
   public-hosts vnc.example.com
   ```
   With remote access on, these names are accepted as HTTP `Host` values and added to the
   generated certificate. An `auto` certificate that doesn't name them yet is **reissued**,
   so every device must install the new certificate on the LAN again (step 5).
3. **Pick a media port range and forward it.** For example:
   ```
   media-ports 40000-40049
   ```
   - Choose 8 to 1000 ports; 50 is plenty for eight devices.
   - On the router, forward that range for **UDP** to this PC with the **same port
     numbers** outside and inside. VidVNC announces the public address with the same port
     numbers it uses locally, so a remapped port won't work.
   - Also forward the range for **TCP** if some of your networks block UDP; WebRTC can
     fall back to TCP on the same ports.
   - New streams use the range; streams already running keep their ports.
4. **Forward the HTTPS port.** Forward the TLS port (default `4383`, TCP) to this PC. If
   the router uses a different public port, usually 443 → 4383, tell VidVNC:
   ```
   public-port 443
   ```
   Without this, a browser that sends `vnc.example.com` (port 443) is refused with `421`.
5. **Set up devices on the LAN.**
   - Install the certificate from `/trust`, and check its fingerprint against the host
     screen.
   - Register the device with a setup code and approve it on the host. The approval
     screen shows where each request came from: _Local network_,
     _Private network (not this LAN)_ or _Internet_.
6. **Turn it on:**
   ```
   remote-access on
   ```
   All of these commands also work offline (`npm run config -- remote-access on`). The
   Windows host accepts `remoteAccess`, `publicHostnames`, `publicPort` and `mediaPorts`
   on its settings pipe, but has no screen for them yet.

**Never forward:**

- the plain HTTP port (`4382`)
- the diagnostics port
- anything else on the PC

Don't put a reverse proxy on this PC in front of VidVNC: every client would then appear
to come from the PC itself, which makes an internet client look local.

**Windows Firewall** must allow the media worker to receive on the media range. If
Windows asks when the first stream starts, allow it on the network profile your LAN uses.

## Limits you should know

- **Device credentials can be copied.** An approved device's secret lives in the browser.
  Someone with that secret **and** the password can sign in as that device. Use a strong
  password, and remove devices you've lost.
- **Denial of service.** Admission, connection and per-address limits stop one machine
  from locking you out. They don't stop a large distributed flood; that needs filtering
  upstream.
- **The generated certificate lists this PC's name and local IPs.** Anyone who connects
  over HTTPS can read them. A `provided` certificate that names only the public host
  avoids this.
- **CGNAT.** If your ISP gives the router no public IPv4 address, port forwarding can't
  work. Use IPv6 if the ISP offers it. Otherwise, a small VPS you control (running
  WireGuard, or your own TURN server) is the cheapest option you still run yourself.

## What has not been tested

- The server logic (classification, HTTPS-only, refused routes, HSTS, public names and
  port, answer rewriting, connection cap, control default) is covered by the portable
  test suite.
- **The native change has not been compiled or run.** It applies the port range to each
  WebRTC peer through GStreamer's `min-rtp-port`/`max-rtp-port` ICE agent properties,
  and a malformed range stops the worker.
- **No real router, public network, or client behind carrier NAT has been used.**

Before relying on it:

1. Build and run `npm run test:hardware` on Windows.
2. Check that the worker's sockets stay inside the range, for example with
   `netstat -ano -p udp` while a stream runs.
3. Connect from a phone on mobile data.

## The alternative: a VPN

WireGuard on the router or the PC exposes one UDP port and no VidVNC port at all. Remote
devices get private VPN addresses, which VidVNC treats as private, not internet. They
connect as they would on the LAN, except the standing password, which stays limited to
the physical LAN. Remote access can then stay off.
