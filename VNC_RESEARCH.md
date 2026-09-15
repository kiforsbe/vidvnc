# Low-Latency VNC Research Notes

Date: 2026-09-09

## Goal

Develop a simple-to-install VNC-style solution for Windows 11 and macOS 27 with:

- Low-bandwidth, high-performance, low-latency point-to-point desktop video.
- A native server and native client.
- Primary-monitor support and optional multiple monitors.
- One stream per server monitor, with flexible client-side monitor mapping.
- Remote keyboard and mouse input.
- A browser client that can run locally or remotely.
- Local-subnet operation first, with a future approved-client/server hub for signaling, tunneling, and relay.
- Smart defaults so the server can be installed and run with minimal configuration.

Current hardware assumption: the server has either an NVIDIA GPU or an Apple M-class CPU/GPU. The client and server may use different architectures, languages, and frameworks.

## User requirements

This section records the requirements and preferences supplied by the user. It is the source of truth for future design and implementation work; recommendations elsewhere in this document are proposals and may be revised.

### Product capabilities

Distribution clarification (2026-09-12): deliver self-contained server/host installers,
native-client-only installers, and CLI-server bundles for **both Windows and macOS**
(six initial OS/product combinations). Server distributions include the server,
browser assets, native workers/libraries and required redistributable runtimes; full
server installers additionally include the native management UI. Users should not
need developer SDKs or separately installed language runtimes. The macOS native
client may become universal later. See [packaging requirements](docs/PACKAGING.md).

- Build a VNC solution with both a client and a server.
- Prioritize low bandwidth, high performance, and low-latency point-to-point streaming video.
- Support Windows 11 version 25H2 or newer as the minimum Windows client/server platform, and support macOS 27.
- Support the server’s primary monitor.
- Optionally support multiple server monitors.
- Allow server monitors to be displayed on one or more client monitors, likely using one stream per server monitor.
- Support standard client-side keyboard and mouse input remotely on the server.
- Prefer a web client that can run from either a local or remote server.
- Allow the remote web server to also be the server whose monitors are being displayed.

### Networking and future connectivity

- Focus the initial version on local networking over a local subnet.
- Keep the architecture open to later remote connections.
- Eventually provide a client/server hub for approved clients and servers.
- The future hub should be able to automatically establish tunneling and connections.

### Hardware, platforms, and implementation choices

- Assume the server has either an NVIDIA GPU or an Apple M-class CPU/GPU.
- Provide reasonable fallbacks when the preferred hardware or acceleration path is unavailable.
- The client and server may use different CPU architectures, programming languages, and frameworks.
- Multiple languages and components may be used on either side when that improves performance or platform integration.
- Low-level C/C++ is acceptable for hardware access and high-performance libraries.
- Use the most appropriate high-level frameworks and languages for each operating system where practical.
- Share lower-level/common code across platforms only when doing so does not harm performance, portability, or ease of maintenance.

### Setup and user experience

- Client and server installation and configuration must be simple and user-friendly.
- The server’s basic setup should be install-and-run.
- On first run, the server should show a window with the IP address and connection information needed by the client.
- The server should provide access management from the initial setup experience.
- A basic password is required as the minimum access-management option.
- Investigate passkeys, including iPhone/iCloud-style passkeys, especially for the web interface.
- The server should automatically choose smart defaults based on its configured monitors.
- The client should also use smart defaults.
- On connection, the client should automatically adapt to display the server’s monitors in the best available way on the client’s monitors.

### Visual and interaction quality

- The user interface must be simple to use and must not look like a developer tool or technical administration console.
- Native desktop clients and server controls must be exceptionally polished and truly native to their host platform; platform styling applied to a shared web-style UI is not sufficient.
- The Windows client/server UI must be designed and implemented as a genuine Windows 11 WinUI 3 experience, using appropriate WinUI 3 controls, layout, window chrome, navigation, dialogs, settings, accessibility, scaling, and system integration so it feels like software made by Microsoft.
- The macOS client/server UI must be designed and implemented with Apple-native macOS technologies and conventions (SwiftUI with AppKit integration where appropriate), using appropriate macOS controls, layout, window chrome, navigation, dialogs, settings, accessibility, scaling, and system integration so it feels like software made by Apple.
- Native UI behavior should include appropriate platform conventions for navigation, dialogs, settings, permissions, menus, keyboard shortcuts, window behavior, dark mode, accessibility, scaling, and localization.
- The web interface should be professional, modern, visually excellent, usable, friendly, and easy to understand without exposing unnecessary implementation details.
- Visual quality, clarity, and ease of use are product requirements, not optional polish to be added after the technical work.

### Research and development workflow

- First investigate viable implementation options and existing libraries or code.
- Identify projects that can be used as-is as well as projects useful for technical inspiration.
- Keep the initial research concise enough for the current Luna Reserve phase.
- Leave detailed research, validation, and implementation planning for a later GPT-6 pass.

## Recommended direction

Use a WebRTC-first hybrid:

```text
Native capture -> native hardware encoder -> WebRTC media tracks
                                          -> WebRTC data channels for input/control
```

Use one `RTCPeerConnection` per client and one video track per server monitor. Keep monitor identity, layout metadata, input, control, and telemetry separate from the encoded video itself.

WebRTC is attractive because it provides peer-to-peer media, encrypted transport, ICE negotiation, browser interoperability, and arbitrary binary data channels. The signaling layer can initially be a small local HTTP/WebSocket service and later become the hub/rendezvous service.

## Platform media paths

### Windows 11

Preferred path:

```text
DXGI Desktop Duplication -> D3D11 texture -> NVENC -> WebRTC
```

Desktop Duplication is well suited to a VNC-style server because it exposes GPU-resident frames, dirty regions, cursor metadata, and multiple displays. Windows Graphics Capture is a useful alternative when user-approved capture and the system picker are preferred, but its visible capture indication and service limitations need to be considered.

References:

- [Microsoft Desktop Duplication API](https://learn.microsoft.com/en-us/windows-hardware/drivers/display/desktop-duplication-api)
- [Microsoft Windows Graphics Capture](https://learn.microsoft.com/en-us/windows/apps/develop/media-authoring-processing/screen-capture)
- [Microsoft Desktop Duplication Win32 documentation](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api)

### Windows 11 25H2 minimum and limitations

Windows support is intentionally limited to Windows 11 version 25H2 or newer. Microsoft lists 25H2 as build 26200. The application should detect the Windows release/build at startup, provide a clear update message for older systems, and avoid silently attempting unsupported capture or input paths.

Relevant consequences of this minimum:

- Windows 10 and Windows 11 22H2, 23H2, and 24H2 are outside the supported product floor, even though some APIs may work on them.
- 25H2 is largely delivered as an enablement update over 24H2, so implementation and testing must still account for cumulative-update differences rather than assuming every 25H2 machine has identical behavior.
- Microsoft’s current lifecycle data lists 25H2 build 26200 through October 12, 2027 for Home/Pro-family editions and October 10, 2028 for Enterprise/Education/IoT Enterprise editions. The product should track supported-release and driver changes rather than treating 25H2 as permanently fixed.
- Windows Graphics Capture must be tested separately in packaged/interactive and service/unattended modes. Desktop Duplication should remain the primary server fallback when service capture or capture-indicator behavior is unsuitable.
- GPU/driver combinations, multi-GPU adapter selection, HDR, DPI scaling, display rotation, hot-plugging, sleep/wake, and remote-session behavior need explicit test coverage.
- Remote input remains subject to Windows integrity/UIPI restrictions, UAC, locked sessions, and secure desktops. The 25H2 minimum does not remove those OS security boundaries.
- The installer and diagnostics should report the Windows build, edition, architecture, GPU, driver, active displays, selected capture backend, and selected encoder so support issues can be reproduced.
- Microsoft’s 25H2 release-health and known-issues pages must be part of ongoing compatibility review. Updates can affect display configuration, graphics drivers, permissions, and desktop behavior even when the application itself is unchanged.

References:

- [Microsoft supported Windows client versions](https://learn.microsoft.com/en-us/windows/release-health/supported-versions-windows-client)
- [Microsoft Windows 11 version 25H2 overview](https://learn.microsoft.com/en-us/windows/whats-new/whats-new-windows-11-version-25h2)
- [Microsoft Windows 11 version 25H2 known issues](https://learn.microsoft.com/en-us/windows/release-health/status-windows-11-25h2)
- [Microsoft Windows lifecycle: Home and Pro](https://learn.microsoft.com/lifecycle/products/windows-11-home-and-pro)

### macOS 27

Preferred path:

```text
ScreenCaptureKit -> IOSurface/CVPixelBuffer -> VideoToolbox -> WebRTC
```

ScreenCaptureKit supports display selection and delivers `CMSampleBuffer` objects. Screen frames can be IOSurface-backed, which is useful for avoiding unnecessary CPU copies. VideoToolbox exposes hardware-accelerated low-latency compression on Apple hardware.

References:

- [Apple ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)
- [Apple ScreenCaptureKit capture sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos?language=objc)
- [Apple ScreenCaptureKit output frames](https://developer.apple.com/documentation/screencapturekit/scstreamoutput)
- [Apple VideoToolbox](https://developer.apple.com/documentation/videotoolbox)
- [Apple low-latency VideoToolbox sample](https://developer.apple.com/documentation/videotoolbox/encoding-video-for-low-latency-conferencing)
- [Apple macOS release notes](https://developer.apple.com/documentation/macos-release-notes)

macOS 27 is currently represented in Apple’s release notes as a beta target, so the implementation should test against the macOS 27 SDK while preserving compatibility with the latest stable macOS where practical.

## Codec strategy

Start with H.264 for predictable browser and native interoperability. Add capability-negotiated alternatives later:

- H.264: default compatibility mode.
- HEVC: useful for native Apple clients, but browser coverage and licensing are less uniform.
- AV1: potentially excellent bandwidth efficiency, but hardware encoding, latency, and client support need validation.
- Software H.264: universal fallback using x264 or another software encoder.

The desktop encoder should use low-latency settings, adaptive bitrate and resolution, frame dropping under congestion, damage-aware frame production, and separate cursor/input metadata where possible. Avoid building a lossless text-overlay mode until the basic path is measured.

NVIDIA references:

- [NVIDIA Video Codec SDK](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/index.html)
- [NVIDIA NVENC programming guide](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/nvenc-video-encoder-api-prog-guide/index.html)
- [NVIDIA FFmpeg hardware acceleration](https://docs.nvidia.com/video-technologies/video-codec-sdk/13.1/ffmpeg-with-nvidia-gpu/index.html)

## Input model

The client should send semantic events rather than only text:

- Physical key/scancode plus modifiers.
- Key press and release independently.
- Absolute mouse position relative to a monitor, preferably normalized.
- Mouse buttons, wheel, and extra buttons.
- Clipboard, touch, pen, gamepad, and IME support later.

Windows can use [`SendInput`](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput), with limitations from integrity levels, UAC, locked sessions, and secure desktops.

macOS can use Quartz events such as [`CGEventPost`](https://developer.apple.com/documentation/coregraphics/cgevent) and should check Accessibility trust with [`AXIsProcessTrustedWithOptions`](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions).

The server should reconcile stuck keys/buttons after disconnect and expose an emergency “release all input” action.

## Existing projects and libraries

### Strong reference implementations

#### Sunshine

[LizardByte/Sunshine](https://github.com/LizardByte/Sunshine) is the closest performance reference. It supports Windows and macOS, NVIDIA NVENC, Apple VideoToolbox, software encoding, DXGI Desktop Duplication, ScreenCaptureKit, remote input, and native Moonlight clients.

It is GPL-3.0 and uses the Moonlight/GameStream protocol. Use it first as a benchmark and source of implementation ideas. Incorporating substantial code requires a deliberate GPL licensing decision.

#### Moonlight Qt

[moonlight-stream/moonlight-qt](https://github.com/moonlight-stream/moonlight-qt) is a strong reference for native rendering, decoding, input, fullscreen behavior, and multi-monitor client behavior. Its protocol uses raw TCP/UDP and does not provide a pure browser client. It is GPL-3.0.

#### RustDesk

[rustdesk/rustdesk](https://github.com/rustdesk/rustdesk) is the best architectural reference for a self-hosted remote-control product. Its source separates capture, input, codecs, platform code, server services, and rendezvous/relay handling. It uses Rust, `scrap`, `enigo`, codecs, and custom networking.

It is AGPL-3.0, so use its structure and behavior as inspiration unless the project is intentionally AGPL-compatible.

### Transport and media building blocks

#### libdatachannel

[paullouisageneau/libdatachannel](https://github.com/paullouisageneau/libdatachannel) is a strong candidate for a lightweight native transport. It provides C++ and C bindings, WebRTC media transport, data channels, WebSockets, ICE, DTLS/SRTP, browser interoperability, and Windows/macOS support. It is MPL-2.0.

It leaves capture and encoding under application control, which is useful for direct NVENC and VideoToolbox integration.

#### Pion WebRTC

[pion/webrtc](https://github.com/pion/webrtc) is a pure-Go WebRTC implementation with ICE, STUN/TURN, mDNS candidates, data channels, RTP/RTCP access, H.264 packetization, congestion control, simulcast, and SVC. It is MIT-licensed.

Pion is especially attractive for a future hub, signaling service, relay, or media gateway. It is less attractive as the primary zero-copy GPU capture path.

#### GStreamer `webrtcbin`

[GStreamer `webrtcbin`](https://gstreamer.freedesktop.org/documentation/webrtc/) provides a complete media pipeline with multiple tracks, data channels, RTP, codec plugins, and WebRTC negotiation. It may be the fastest route to a broad media prototype, at the cost of runtime/plugin packaging complexity and less direct control over GPU resource ownership.

#### FFmpeg

[FFmpeg](https://github.com/FFmpeg/FFmpeg) is valuable for software encoding, hardware-acceleration integration, scaling, pixel-format conversion, and diagnostics. It is not a complete WebRTC session layer. The codebase is mainly LGPL, with optional GPL components.

### Capture and input utilities

- [scrap](https://github.com/quadrupleslap/scrap): simple cross-platform Rust capture for Windows, macOS, and Linux. It returns CPU-readable BGRA frames, making it useful for a prototype/fallback but not ideal for a zero-copy production path.
- [enigo](https://github.com/enigo-rs/enigo): MIT-licensed cross-platform Rust mouse/keyboard simulation for Windows and macOS. Useful as an abstraction or prototype component; direct native APIs may still be needed for edge cases.
- [OBS Studio](https://github.com/obsproject/obs-studio): mature capture/compositing/encoding reference, including D3D11 and Metal paths. GPL-2.0, so generally reference-only unless compatible licensing is intended.
- [Looking Glass](https://looking-glass.io/): useful inspiration for shared-memory, zero-copy, and low-latency display pipelines, though it is primarily a VM/shared-memory viewer rather than a network protocol.

### Browser/compatibility fallbacks

- [noVNC](https://github.com/novnc/novnc): useful conventional browser VNC client and compatibility fallback, but not the primary low-latency video path.
- [Apache Guacamole](https://guacamole.apache.org/): browser gateway for VNC/RDP/SSH, Apache-2.0, useful for compatibility access but not a substitute for a low-latency WebRTC design.

## User-friendly onboarding design

### Server first run

The server should open a setup window on first run showing:

- Friendly server name.
- Detected monitors.
- LAN IPv4 and IPv6 addresses.
- Port and QR-code connection URL.
- One-time pairing code.
- Generated temporary password.
- Local-network-only default.

The setup page should allow the owner to rename the server, enable/disable input control, approve clients, register passkeys, and revoke existing clients.

### Client first run

The client should:

1. Discover nearby servers through mDNS.
2. Offer QR scanning.
3. Fall back to manual IP/port/pairing-code entry.
4. Show server identity, OS, monitor list, and requested permissions.
5. Automatically map the server primary display to the client primary display.
6. Map additional displays to additional client displays where possible.
7. Use a combined layout when the client has fewer displays.

The client should not change local resolution or refresh rate without explicit permission.

### Passkeys/WebAuthn

Use WebAuthn for passkeys. Apple passkeys can use iCloud Keychain and can authenticate on non-Apple devices; Windows 11 supports Windows Hello, FIDO2 keys, and cross-device passkey flows.

Important limitation: WebAuthn is exposed only in secure contexts, normally HTTPS, and its relying-party identity is tied to the web origin/domain. A remote browser opening plain `http://192.168.x.x` is therefore not a reliable passkey origin.

Recommended flow:

1. Bootstrap local access with a one-time pairing code and generated password.
2. Register a passkey after the session is established, when the browser/origin supports it.
3. Keep password and recovery-code fallback available.
4. Use a hub-backed, publicly trusted HTTPS hostname later for the cleanest passkey experience.

References:

- [W3C WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/)
- [W3C Secure Contexts](https://www.w3.org/TR/secure-contexts/)
- [Apple passkeys](https://developer.apple.com/passkeys/)
- [Apple passkeys in web browsers](https://developer.apple.com/documentation/authenticationservices/passkey-use-in-web-browsers?changes=_9&language=objc)
- [Microsoft WebAuthn APIs](https://learn.microsoft.com/en-us/windows/security/identity-protection/hello-for-business/webauthn-apis)
- [Microsoft passkey support](https://learn.microsoft.com/en-us/windows/security/identity-protection/passkeys/)

Cross-device phone authentication may require Bluetooth and, depending on the platform flow, Internet connectivity. Password/pairing fallback is required for isolated networks.

## Automatic capability negotiation

The initial control exchange should describe:

- Server monitor IDs, dimensions, refresh rates, orientation, scale, and desktop coordinates.
- Client physical monitors and available display areas.
- Supported codecs and decoder capabilities.
- Desired layout and maximum bandwidth.
- Input capabilities.

The server should then choose sensible resolution, frame rate, bitrate, and codec settings automatically. The client should be able to override them later, but the first connection should require no tuning.

## Authentication and authorization

Separate:

1. Human authentication: password, passkey, Windows Hello, Apple passkey, or security key.
2. Client authorization: a specific approved client device with a revocable identity key.

After pairing, the client should reconnect using its device identity rather than repeatedly prompting for the password. The server should list clients, platforms, last connection, permissions, and revoke controls.

The server must authenticate and authorize a client before accepting its WebRTC session. LAN visibility alone must not grant access.

## Future hub

Keep discovery/signaling independent of media transport:

```text
Local discovery -> direct WebRTC connection
Remote access  -> hub signaling + STUN/TURN or an explicit tunnel
```

The future hub can manage device identities, approved relationships, signaling, ICE exchange, optional TURN relay, audit logs, revocation, pairing codes, and reverse tunnels. Local operation should not require the hub.

## Suggested implementation sequence

### Phase 0: performance/reference benchmark

Run Sunshine/Moonlight on the target Windows/NVIDIA and macOS/Apple hardware. Measure capture-to-display latency, bandwidth, frame pacing, monitor behavior, and input responsiveness.

### Proposed minimal proof of concept: one-screen local vertical slice

The first sub-project should prove the complete interactive loop on one well-supported reference target before adding multi-monitor layout, passkeys, tunnelling, polished native client shells, or the second native platform. It should be intentionally small: one server executable and a web client embedded in and served by that same executable.

#### Reference target

- Server: Windows 11 25H2 or newer with an NVIDIA GPU and current driver.
- Network: same local subnet, with manual IP/hostname entry initially.
- Display: primary monitor only, ideally 1920 × 1080 at 60 Hz for repeatable measurements.
- Client: a browser page served directly by the server; no separate web server, account, installer, or client application is required.
- Security boundary: trusted-LAN experiment only. Do not expose the POC port to the Internet or an untrusted network; the short password is not a substitute for the final TLS, pairing, passkey, and authorization design.

#### POC deliverables

1. A single Windows server executable that binds to the local subnet, prints or shows the connection URL, and generates a short-lived password in a human-friendly format such as `ABCD-EFGH`. Include a simple regenerate/stop action, but do not build the final onboarding UI yet.
2. The same executable serves the static web client and provides the minimal HTTP/WebSocket signaling endpoint. No separate web server, database, account system, discovery service, or configuration file is required.
3. A server media path using DXGI Desktop Duplication, NVENC H.264 low-latency encoding, and WebRTC. Use GStreamer `webrtcbin` for the fastest experiment; keep a `libdatachannel` path as the likely lower-level alternative if pipeline control or native-client reuse becomes limiting.
4. A browser client with one obvious Connect action, password entry, live primary-monitor video, fullscreen, and an explicit Enable keyboard and mouse control toggle.
5. A small input data-channel protocol limited to mouse movement, buttons, wheel, key down/up, and an emergency Stop control. The Windows input sink should use `SendInput` and report permission or secure-desktop limitations clearly.
6. A diagnostics overlay that can be toggled on demand and records capture timestamp, encoded frames, decoded frames, dropped frames, bitrate, round-trip input timing, and reconnect events.

#### Shared-boundary rule

Keep the POC’s transport/session messages independent of the WinUI 3 shell. Define replaceable boundaries for `CaptureSource`, `Encoder`, `InputSink`, and `SessionTransport`, even if the first implementation only has one concrete backend. This preserves a clean path to ScreenCaptureKit/VideoToolbox on macOS and to a future native client without prematurely building a large abstraction framework.

#### Suggested success gates

- A fresh server can be started and connected to on the local subnet without editing a configuration file.
- The server itself is the only service needed: opening its displayed URL loads the web client, and the displayed generated password authorizes the session.
- The browser receives a stable 60 Hz primary-monitor stream with no sustained frame backlog during normal desktop motion.
- Hardware encoding is confirmed in diagnostics; if unavailable, the server falls back to a documented software H.264 path at reduced quality or frame rate.
- Mouse and keyboard input reaches the server responsively, can be disabled immediately, and does not silently claim control when the session is not authorized. The password is rate-limited and can be regenerated or invalidated.
- The measured local-network capture-to-display and input timings are recorded rather than guessed; a practical initial target is sub-50 ms input response on a wired LAN.
- A short network interruption either reconnects automatically or returns to a clear reconnect state without leaving input enabled unexpectedly.

#### Explicit non-goals for the proof of concept

Do not include multiple monitors, monitor-to-monitor mapping, passkeys/WebAuthn, the future hub, Internet traversal, polished native server/client windows, a native client application, macOS capture, or a production installer. The final product still requires true WinUI 3 and SwiftUI/AppKit applications; the proof of concept deliberately isolates the streaming and input risk first.

### Phase 1: browser-capable proof of concept

- One server monitor.
- Windows Desktop Duplication and macOS ScreenCaptureKit.
- H.264 hardware encoding.
- WebRTC transport.
- Browser client.
- Mouse/keyboard data channel.
- Local manual signaling.

Evaluate `libdatachannel` first and GStreamer `webrtcbin` in parallel if rapid pipeline experimentation is valuable.

### Phase 2: product onboarding

- First-run server window.
- QR code and mDNS discovery.
- One-time pairing.
- Password-based access management.
- Automatic monitor/capability negotiation.
- Reconnect identity and client revocation.

### Phase 3: native clients and multi-monitor UX

- SwiftUI/AppKit macOS client.
- WinUI 3 Windows client.
- Native decoder paths.
- One fullscreen window per mapped stream.
- Combined desktop and fallback layouts.

### Phase 4: remote connectivity

- HTTPS/WebSocket hub.
- Passkey-backed hub authentication.
- STUN/TURN.
- Approved client/server management.
- Optional reverse tunnel.

## Main recommendation

Use native platform capture and encoding, a lightweight WebRTC transport such as libdatachannel or GStreamer, and a shared protocol/session model rather than forcing all platform code into one language.

Use Sunshine, Moonlight, RustDesk, OBS, and Looking Glass primarily as implementation and performance references. Use RustDesk’s `scrap`/`enigo` ideas for fallback abstractions, but do not assume their CPU-frame paths are sufficient for the final zero-copy design.

The first meaningful prototype should prove one Windows monitor and one macOS monitor in a browser before building the full native multi-monitor shell.
