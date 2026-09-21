# Changelog

All notable changes to VidVNC are listed here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and VidVNC uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, any release
may include breaking changes.

## [Unreleased]

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
