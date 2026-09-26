# Changelog

All notable changes to VidVNC are listed here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and VidVNC uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, any release
may include breaking changes.

## [Unreleased]

### Fixed

- Touch control in the browser viewer: dragging a finger now only moves the pointer instead of
  clicking when the finger lifts. A quick tap clicks. To drag and drop, tap and then touch again
  and drag, or touch and hold still briefly before dragging.

## [0.9.0] - 2026-09-25

### Added

- A configurable `public-name` login label (default `VidVNC host`); the anonymous
  `/api/info` response now contains only that owner-chosen label. The native host can edit it
  in Settings and displays it on Overview alongside the computer name.
- The host and CLI now issue one-time connection and client-registration codes only on explicit
  request. Codes expire after five minutes by default and can be used once. The host offers
  letters-and-numbers or letters-only codes; the CLI and configuration file allow bounded
  changes to code lifetime, attempt limits, alphabet, and eligible local networks.
- The host and CLI can explicitly disconnect existing ordinary sessions when immediate
  lockdown is needed. The CLI's `diagnostics open` command and the host's Diagnostics action
  create a short-lived link to a separate loopback-only diagnostics listener on demand.
- An opt-in remote access mode: `public-hosts <name-or-ip>...` and
  `connection-mode approved-only`, then `remote-access on` (also accepted from the host over
  its settings pipe). Remote access requires `approved-only` mode, so no short-code admission
  exists for anyone while it is on, and switching it off disconnects internet sessions at
  once. While it is off, clients with an
  internet source address are refused outright; private networks that are not this LAN, such
  as a VPN, keep today's rules. While it is on, internet clients reach only HTTPS, sign in only
  as approved devices (short codes, device setup and certificate enrolment stay on the local
  network), get HSTS on the public names, and have those names accepted as HTTP `Host`
  values and added to the generated certificate.
- The Windows host's sharing indicator in the navigation pane is now the sharing switch:
  - select it to start sharing on the local network, or to stop sharing;
  - its arrow (or a right-click) starts sharing with remote access, or turns remote
    access on or off while sharing;
  - remote access shows on the indicator as a globe and **Remote access on**.

  Each start is local-only unless remote is chosen. The footer's Stop sharing button is gone.
  **Settings → Remote access** edits the public names, public HTTPS port and media ports, also
  while sharing is off (through the offline settings command), without turning remote access
  on.

- Media through a router without a relay. `media-ports <first>-<last>` pins the ports video,
  audio and input use (the worker applies it to every WebRTC peer through
  `VIDVNC_ICE_PORTS`), so the range can be forwarded to this PC. An internet client's SDP
  answer then names the router's public address (the public names, with DNS names resolved at
  answer time) on the same ports, and private addresses are removed from it.
- `public-port <port>`: the HTTPS port internet devices use when the router forwards a
  different public port (usually 443) to this PC's HTTPS port. Before, any `Host` port other
  than the listener's own was refused with `421`, which broke that ordinary router setup.
- Carrying a device key to the remote address. Browsers keep saved data per address, so a
  device approved at the LAN address had no key at the public one. Once a public name is
  set, the sign-in page on the LAN offers **Open remote address** and **Copy link**; the
  link carries the key after `#`, which is never sent to a server, and the page that opens
  stores it without replacing a different key.
- iPhone: turning on keyboard and mouse fills the screen with the desktop inside the page,
  so touches still reach it (Safari's own full screen is a video player that takes input
  away). Releasing them returns to the normal view.
- VidVNC can be added to the Home Screen (web app manifest and icons), where it opens
  without the browser's bars. Content stays clear of the notch and status bar.
- The Windows host appends unhandled exceptions to `host-crash.log` in its logs folder.
- Every test command brings dependencies up to date first: npm packages are reinstalled
  when they don't match the lockfile, a media worker older than its sources is rebuilt,
  and the GStreamer SDK version is checked.

### Changed

- The Windows host's **Connect a device** dialog fits without scrolling. Generating a code
  shows its QR code large, beside the key and address; **Back** returns to the setup view
  and **Done** closes the dialog.
- The Overview host card says only where sharing reaches ("local network" or "remote
  access"), without a separate availability sentence.
- The security reviews, remediation proposals and status notes are collected into one
  current document, [Internet exposure: security analysis and status](docs/security/internet-exposure.md).
- Removed the browser-credential explanation from the web sign-in form; registration still
  asks for a browser/client label, and the credential's security behavior is unchanged.
- Connection codes remain eight characters but no longer encode their purpose and exclude
  easily confused `0`, `1`, `I`, `L`, and `O`. The reusable session password is intended for
  the host PC or an eligible local LAN subnet, not a public-scoped listener. The live server
  now injects the detected Private-LAN scope into its HTTP admission path.
- An approved browser/client secret remains a copyable credential in addition to username and
  password, not device proof. It can have only one live session. Removing or
  changing permissions immediately invalidates its active sessions and starts stream/control
  teardown; the host reports success only after teardown and persistence.

### Fixed

- An outsider could lock every approved device out of sign-in: sign-in, registration and
  claim polling shared one server-wide budget, and IPv6 sources weren't grouped. Those
  budgets are now separate for internet and for local/private peers, the internet sign-in
  budget is larger, and every per-source count groups IPv6 by /64.
- Internet clients' WebRTC offers keep only candidates on public addresses, so a signed-in
  client can no longer aim the host's connectivity checks at machines on the LAN. With a
  media port range set, the worker offers UDP only (no ICE-TCP).
- `100.64.0.0/10` counts as a private network only while this PC has an adapter in it (an
  overlay VPN such as Tailscale); otherwise it is an ISP's carrier-grade NAT and counts as the
  internet.
- With remote access on, the generated certificate omits the PC's hostname.
- Diagnostics show the video element's paused and ready state for multi-stream sessions
  too, and the viewer sizes its stage from the decoded frame size when Safari reports none.
- F8: a pending device registration is labelled from the address that actually sent it
  (`Local network`, `Private network (not this LAN)` or `Internet`), not from the listener,
  which both HTTP and HTTPS share.
- A blanket `available` keyboard-and-mouse default no longer grants control automatically to a
  session from the internet; it still asks. An approved device set to `available` keeps it.
- One source address can hold at most 12 connections per listener (IPv6 grouped by /64), so a
  single machine can no longer take every connection slot.
- Anonymous visitors can no longer fetch viewer markup, viewer-specific CSS/JavaScript,
  or the stream helper modules. The browser loads them only after admission, using a
  session-bound viewer cookie that is invalidated immediately on revocation.
  Private session, signaling, and stream APIs still require the separate bearer token.
- Removed the anonymous connection-key inspection and legacy connect routes. Key starts and
  approved-client admission now have server-wide and per-source attempt limits, bounded
  password-verification work, and expiring registration state.
- Control grants and lease renewals check current permission, and in-flight authenticated HTTP
  responses recheck session validity. Diagnostics pages, API, and diagnostics-only assets are
  absent from the public-capable HTTP/HTTPS ports; the private listener still requires an
  owner-issued bearer capability for live data.
- HTTP now binds only loopback and eligible Private-LAN addresses and rechecks peers after
  adapter changes. Unexpected TLS failure or invalid settings refuse viewer, login, and
  signaling over HTTP; active HTTPS redirects them. Absolute-form request targets cannot
  bypass that redirect, and trust pages/trust-specific assets/API are local-peer-only on both schemes.
  Valid explicit TLS-off mode remains a LAN-only HTTP viewer. CLI and native-host status
  show no viewer URL and disable Connect/Preview while required HTTPS is unavailable.

### Known limitations

- Remote access is only partly validated: it has streamed through one real router, but
  hasn't had a packet capture or an IPv6 run. Certificate enrolment stays on the LAN, and a
  router or program that rewrites source addresses makes internet clients look local
  (setup includes a check for this). An approved browser's secret is still copyable, and
  in-process limits don't replace an internet-facing traffic filter. A self-hosted VPN
  remains the recommended way in. See the
  [security analysis and status](docs/security/internet-exposure.md).

## [0.8.0] - 2026-09-23

### Added

- The **Connect a device** dialog now provides a locally generated QR code for the selected
  session password, one-time connection key, or client setup key. Scanning it opens VidVNC on
  the device and pre-fills the connection form, so the person can explicitly choose Connect or
  continue with client registration.

### Fixed

- QR connection links keep their key in the URL fragment rather than an HTTP request, and clear
  it from the address bar before any API call. When iPhone Safari reuses an already-open VidVNC
  page, a fragment change now still pre-fills the connection form without requiring a reload.

## [0.7.1] - 2026-09-22

### Fixed

- Automatic encoder selection no longer opens a disposable NVIDIA D3D11 encoder in the live
  streaming worker. That probe could leave H.265 unable to open an NVENC session after a WebRTC
  peer connected. Hardware affinity is now detected during the isolated startup probe and the
  selected backend is passed directly to the live worker.
- The desktop host now persists native-worker lifecycle and GStreamer errors to `server.log`, so
  a failed encoder or negotiation can be diagnosed without running the server from a terminal.
- Sessions and the local Diagnostics page show the encoder actually selected for the stream. The
  host session layout keeps session actions in the device header and each stream's Stop action
  with that stream.

## [0.7.0] - 2026-09-22

### Added

- VidVNC now serves HTTPS by default. On first run it provisions its own certificate
  automatically: an operator-supplied certificate if one is configured, otherwise
  mkcert's local certificate authority if `mkcert` is on `PATH` (no browser warning on
  any device that already trusts that authority), otherwise a self-signed certificate
  issued through Windows. A plaintext listener stays up on the original port solely to
  serve the enrolment page and redirect everything else to HTTPS; `off` mode remains
  available for anyone who wants today's plain-HTTP behaviour unchanged.
- A new enrolment page at `/trust` walks a device through installing the host's trust
  anchor, with per-platform instructions (iOS's two-step install-then-trust, Windows,
  Android, macOS) and a SHA-256 fingerprint to compare against the one shown in the host
  UI before installing.
- The VidVNC app's host UI has a new TLS section: current mode, active strategy, port,
  certificate expiry, fingerprint, a QR code linking to `/trust`, and a "regenerate"
  action.
- The command line gets `tls-mode`, `tls-port`, `tls-cert`, `tls-pfx` and `tls` (status)
  commands, matching the existing configuration command style.

### Fixed

- The web client's sign-in page and the VidVNC app's Overview page both carried a fixed
  "pairing uses HTTP" note left over from before HTTPS existed. Both now reflect the
  actual connection: the sign-in page reads it from the page's own scheme, and the
  Overview page reads it from the live TLS status, repainting if that status changes
  while the page is open.

### Known limitations

- **A default install still shows a browser warning on any device that has not
  enrolled.** This is expected, not a bug: enrolling a device by visiting `/trust` and
  installing the certificate is a one-time step per device, not something the server can
  do on the user's behalf.
- **A device approved before upgrading must re-pair once over HTTPS.** The
  approved-client credential is stored per browser origin, so a device approved on
  `http://host:4382` is not automatically approved on `https://host:4383` — it re-pairs
  the first time it connects over HTTPS.
- **Regenerating a self-signed certificate invalidates every enrolled device's trust;
  mkcert does not.** Under the Windows self-signed strategy the certificate is its own
  trust anchor, so every reissue — automatic near expiry or manual via "regenerate" —
  means enrolled devices must enrol again. mkcert's anchor is a stable local authority,
  so its reissues need no re-enrolment. See
  [ARCHITECTURE.md](docs/ARCHITECTURE.md#tls-and-trust-provisioning) for the rest of the
  known limitations, including a mid-session disconnect a client can hit if it was
  loaded over plaintext right as TLS came up.

## [0.6.0] - 2026-09-21

### Added

- VidVNC now encodes on Intel and AMD graphics as well as NVIDIA, including the
  integrated graphics built into most processors. Four encoders are supported: NVIDIA
  NVENC, Intel Quick Sync, AMD AMF and Windows Media Foundation. An NVIDIA card is no
  longer required.
- VidVNC picks the encoder for you, preferring the graphics card that is driving the
  display it is capturing. On a laptop with both integrated and discrete graphics this
  avoids copying every frame from one card to the other.
- A new **Encoder** setting on the Codecs page, and the `encoder-backend` CLI command,
  name a specific encoder instead. Only encoders your PC actually has are offered. A
  saved setting naming hardware this PC does not have falls back to automatic rather
  than refusing to stream, so a settings file can be copied between machines.
- Sessions and diagnostics show which encoder is in use and why it was chosen.

### Changed

- H.265 and AV1 availability is now decided per encoder rather than per codec, because
  the minimum picture size an encoder accepts differs by vendor. A small custom profile
  that one graphics card refuses may be accepted by another in the same PC.
- An encoder is offered only after it passes a short real encode at startup. Hardware
  that reports a capability it cannot deliver is dropped instead of producing a stream
  that fails later. On the development machine this correctly dropped AV1 from AMD AMF.

### Fixed

- The VidVNC app and the command line said "NVIDIA" regardless of the graphics card
  present, so AMD and Intel PCs were told they had an NVIDIA encoder. They now name the
  encoder actually in use, and troubleshooting messages say "graphics driver".

### Known limitations

- **Intel Quick Sync is untested.** No Intel graphics was available during development.
  It ships behind the same startup self-test as every other encoder, so if it does not
  work on your PC it is dropped and another is chosen rather than leaving you with a
  dead stream. Reports from Intel hardware are welcome.
- There is still no software encoder and no software capture fallback. A graphics card
  with a working hardware encoder is required.

## [0.5.0] - 2026-09-20

### Added

- Streaming profiles can use variable bitrate. Each profile has a bitrate mode (Constant or
  Variable) and a quality level (Efficient, Balanced or High). In Variable mode the bitrate
  setting is the sustained maximum: the encoder spends less on simple content and can burst
  above it briefly. Existing profiles stay Constant. The profile editor, the CLI `profiles`
  commands, the profile picker and diagnostics all show the mode.
- `npm run start:cli` and `npm run start:host` run the CLI and the Windows host from a
  checkout. `start:host` first rebuilds whatever is out of date: the media worker, the host
  and the runtime manifest.

### Changed

- The profile editor is tidier. Output size is one editable dropdown of `width × height`
  sizes that shows the aspect ratio, frame rate is an editable dropdown, and bitrate mode
  and quality share a row. The unused fixed/variable frame delivery option is gone.
- The Streaming profiles table shows the bitrate on two short lines so the columns fit.
- Sessions in the VidVNC app, the CLI `sessions` list, the web diagnostics page and the web
  profile picker show a profile's name instead of its id. A tooltip gives the description
  and the size, frame rate and bitrate.

## [0.4.1] - 2026-09-18

### Fixed

- The interactive server console keeps prompt editing, command history and Tab completion
  working when the host environment reports a dumb terminal.

## [0.4.0] - 2026-09-18

### Added

- The web client can show the remote desktop in Chrome Picture-in-Picture. Entering
  Picture-in-Picture releases keyboard and mouse control, and control remains unavailable
  until returning to the browser.

## [0.3.1] - 2026-09-16

### Added

- `npm run package` builds every Windows package: the CLI ZIP with and without
  prerequisite installers, and the VidVNC app MSIX with and without bundled Node.js.
  `npm run build` now also builds the VidVNC app.

### Fixed

- AV1 streaming now works from the packages. They were missing the plugin AV1 needs, so
  the installed app and CLI server only offered H.264 and H.265.
- A package build no longer loses the previous build output when Windows briefly locks
  the new files; it retries the swap and restores the previous output if it still fails.

## [0.3.0] - 2026-09-16

### Added

- AV1 and H.265 hardware encoding, alongside H.264, with the codec chosen per device
  from what the browser can decode and the host's configured order. A `codecs` command
  and a Video codecs card let the host view and reorder supported codecs.

### Changed

- Sessions in the VidVNC app and the `sessions` command show each stream's codec.

### Fixed

- H.265 video stayed black in Safari on iPhone. Video now plays when a browser
  numbers its codec below 96 (Safari numbers H.265 as 35).

## [0.2.0] - 2026-09-15

### Added

- Approved clients. The host can approve a device once with a Client setup key; the
  device then signs in with a username and password, without another connection key.
  The VidVNC app has a Clients page for pending requests and approved clients, with a
  control permission for each client (use the Access default, get control when it's
  available, or view only).
- Connection modes on the host: a reusable Session key, One-time connection keys, or
  approved clients only. A shared Connect a device dialog shows and creates keys.
- A device limit in Access settings, from 1 to 8 devices (default 4). Changes apply to
  new connections and never disconnect connected devices.
- Sessions in the VidVNC app and the `sessions` command show when a stream is shared
  with other devices.

### Changed

- Devices viewing the same display with the same profile now share one capture and one
  hardware encode, and devices with the same audio format share one audio capture.
  This saves GPU encoder sessions, so more devices can watch at once. Each device still
  has its own connection, metrics, recovery and control.
- A device that fails or disconnects no longer interrupts other devices watching the
  same display.
- The connection key field accepts exactly eight letters and ignores other characters.
- The Connect action moved into the Overview session card.

## [0.1.0] - 2026-09-15

The first development preview, for Windows and trusted local networks. It is not
production-ready.

### Added

#### Streaming

- Low-latency desktop streaming from Windows 11 25H2 (build 26200) or later on x64,
  with NVIDIA H.264 hardware encoding. There is no software fallback.
- DXGI capture of a selectable display, with per-display sharing and default profiles,
  switching between shared displays, handling for displays being plugged in or removed,
  and an Identify label on each display.
- Desktop audio captured with WASAPI and compressed with Opus.
- Up to two connected devices, each with up to two video streams and its own audio
  stream.
- Streaming profiles that can be added, edited, duplicated, removed, turned on or off
  and reordered, plus allowed sizes, frame rates and bitrates for devices that
  customize their stream. Automatic chooses a starting profile.

#### Browser client

- A viewer served by VidVNC: open the address on another device on the local network
  and enter the password.
- Choose Automatic or one of the host's profiles; the stream reconnects with the new
  choice right away.
- Keyboard and mouse control for one device at a time. The host grants and revokes
  control, and new connections either wait for approval (the default) or get control
  when it's available.

#### VidVNC app (Windows host)

- A WinUI 3 app with Overview, Displays, Streaming profiles, Sessions, Access and
  Settings pages.
- Sessions shows each device's streams and source displays, with Grant, Revoke and Stop
  actions.

#### VidVNC Server (command line)

- Commands for every setting the VidVNC app can change.
- An interactive prompt that shows connected devices and which one has control, with
  Tab completion, command history, and `exit` and `quit` commands that ask before
  disconnecting devices.
- `config` commands that change settings while the server is stopped, with `--json`
  output for read commands.

#### Diagnostics

- A diagnostics page at `http://127.0.0.1:4382/diagnostics` on the server PC, and logs
  and metrics in `%LOCALAPPDATA%\VidVNC\logs`.

#### Packages

- VidVNC Server, an unsigned ZIP for the command-line server.
- VidVNC app, an MSIX signed with a self-signed development certificate, with a script
  to trust that certificate. It can include Node.js and the prerequisite installers.
- Both packages include third-party license notices and a file inventory.

#### Project

- Licensed under AGPL-3.0-only, with commercial licenses available (see
  [LICENSING.md](LICENSING.md)).
- Issue templates, a contributing guide and a security policy.
- `npm run set-version -- <x.y.z>`, which sets the version everywhere it is declared.
- Formatting checks, portable tests and hardware tests, and a `Portable checks`
  workflow that runs when started manually.

### Known limitations

- Acceptance testing of multiple devices on real hardware is still in progress.
- No macOS server, native viewer apps, passkeys, remote access or production security
  hardening yet. See [the roadmap](docs/ROADMAP.md).
