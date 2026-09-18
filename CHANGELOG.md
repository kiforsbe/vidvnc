# Changelog

All notable changes to VidVNC are listed here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and VidVNC uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, any release
may include breaking changes.

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
