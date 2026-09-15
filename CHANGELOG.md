# Changelog

All notable changes to VidVNC are listed here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and VidVNC uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, any release
may include breaking changes.

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
