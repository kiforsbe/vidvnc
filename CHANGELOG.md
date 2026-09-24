# Changelog

All notable changes to VidVNC are listed here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and VidVNC uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, any release
may include breaking changes.

## [Unreleased]

### Added

- The host and CLI now issue one-time connection and client-registration codes only on explicit
  request. Codes expire after five minutes by default and can be used once. The host offers
  letters-and-numbers or letters-only codes; the CLI and configuration file allow bounded
  changes to code lifetime, attempt limits, alphabet, and eligible local networks.
- The host and CLI can explicitly disconnect existing ordinary sessions when immediate
  lockdown is needed. The CLI's `diagnostics open` command and the host's Diagnostics action
  create a short-lived link to a separate loopback-only diagnostics listener on demand.

### Changed

- Connection codes remain eight characters but no longer encode their purpose and exclude
  easily confused `0`, `1`, `I`, `L`, and `O`. The reusable session password is accepted only
  from the host PC or an eligible local LAN subnet, not from a public-scoped listener.
- An approved browser/client secret is explicitly described as a copyable credential in addition
  to username and password, not as device proof. It can have only one live session. Removing or
  changing permissions immediately invalidates its active sessions and starts stream/control
  teardown; the host reports success only after teardown and persistence.

### Fixed

- Removed the anonymous connection-key inspection and legacy connect routes. Key starts and
  approved-client admission now have server-wide and per-source attempt limits, bounded
  password-verification work, and expiring registration state.
- Control grants and lease renewals check current permission, and in-flight authenticated HTTP
  responses recheck session validity. Diagnostics pages, API, and diagnostics-only assets are
  absent from the public-capable HTTP/HTTPS ports; the private listener still requires an
  owner-issued bearer capability for live data.

### Known limitations

- These changes harden the existing LAN service; they do **not** make it ready to expose to the
  Internet. HTTPS trust enrollment and WebRTC routing for remote access remain unresolved. An
  approved browser's secret is still copyable, and in-process limits do not replace an
  Internet-facing traffic filter. See the [security implementation status](docs/security/internet-exposure-hardening-status-2026-09-24.md).

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
