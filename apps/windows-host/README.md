# Native Windows server host

Status: the VidVNC app for Windows, a WinUI 3 app on .NET 10 that owns the PC's
server-management UI and the server process's lifetime. It speaks the
[owner protocol](../../docs/ARCHITECTURE.md#owner-protocol), as the
[Mac host](../macos-host/README.md) does. Installing it is in
[Install and run](../../README.md#vidvnc-app), and building and running it from source in
[Build and run (Windows)](../../README.md#build-and-run-windows): `npm run prepare:host`, then
`npm run start:host`.

## Using the app

Open **VidVNC** from the Start menu. It starts sharing on your local network straight away.
The pages are in the navigation pane on the left; **Sharing is on** at the bottom of it shows
whether sharing is on and opens the sharing menu, and **Settings** is below it. Every page
has **Open preview** and **Connect a device** at the bottom. These screenshots come from
`npm run screenshot:host` and follow your GitHub theme; all of them are in
[docs/images](../../docs/images/README.md).

### Overview

<p align="center"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../docs/images/windows-host/overview-dark.png">
  <img src="../../docs/images/windows-host/overview-light.png" width="720" alt="Overview: this PC's name, sharing on the local network, its two displays">
</picture></p>

The PC's public login name, whether sharing is on and where, how many devices and display
streams are connected, and your displays.

- **Connect a device** shows the address and a key or QR code for another device (below).
- **View sessions** opens Sessions; **Manage displays** opens Displays.
- **Connection security** shows the HTTPS certificate's fingerprint, which a device can
  check before it trusts the certificate.
- **Sharing is on** in the navigation pane: select it to stop sharing, or select it when it
  says **Sharing is off** to start again with a new password. Its arrow opens a menu to start
  sharing on the local network or with remote access, turn remote access on or off, or go to
  the remote access settings.

### Connect a device

<p align="center"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../docs/images/windows-host/connect-device-qr-dark.png">
  <img src="../../docs/images/windows-host/connect-device-qr-light.png" width="720" alt="Connect a device: a QR code with its key and the connection address">
</picture></p>

Choose **Connect a device** to add a phone, tablet or another computer.

1. Pick the **Connection type**: **Use session key** (reusable while this sharing runs),
   **Create one-time key** (single use, for a few minutes) or **Approve this client** (a
   setup code; the device then becomes an approved client, which you approve on Clients).
   Which ones are offered depends on the connection method on Access.
2. For the session key, choose **Show QR code**. For the others, choose **Generate one-time
   code** or **Generate client-registration code**, which goes straight to the QR code.
3. On the other device, scan the QR code with the camera, or open the address in a browser
   and enter the key. On an iPhone, use Safari.

**Back** returns to the choices; **Done** closes the dialog.

### Displays

<p align="center"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../docs/images/windows-host/displays-dark.png">
  <img src="../../docs/images/windows-host/displays-light.png" width="720" alt="Displays: two displays side by side, the main display selected with its profile settings">
</picture></p>

Your screens, arranged as on your desktop. Select a display in the map or its row to see its
settings.

- **Sharing** on each display chooses whether viewers can see it.
- **Default profile** picks the streaming profile a viewer starts with on that display.
- **Host defaults** sets the default profile for every display and whether **Desktop
  audio** is shared.
- **Identify displays** shows each display's number on its screen for a few seconds; the
  numbers match the viewer's display list.

Changes wait until you choose **Apply**; **Cancel** drops them.

### Streaming profiles

<p align="center"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../docs/images/windows-host/streaming-profiles-dark.png">
  <img src="../../docs/images/windows-host/streaming-profiles-light.png" width="720" alt="Streaming profiles: six profiles with their output size, frame rate and bitrate">
</picture></p>

The profiles viewers can pick from, in the order they see them.

- The switch on each profile makes it available to viewers or hides it.
- The **⋯** menu edits, duplicates, removes or moves a profile; **New profile** adds one
  and **Restore defaults** brings back the built-in set.
- Further down, **Client customization** chooses between **Approved profiles only** and
  **Approved options**, where viewers combine any allowed size, frame rate and bitrate
  (**Edit allowed options**). **Encoder** picks the graphics card that encodes, and
  **Video codecs** which codecs viewers may use; H.264 is always available.

### Sessions

<p align="center"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../docs/images/windows-host/sessions-dark.png">
  <img src="../../docs/images/windows-host/sessions-light.png" width="720" alt="Sessions: no connected devices and no display streams">
</picture></p>

Who is connected now: one card per device with its display streams, their size, frame rate,
profile and codec, and how the connection is doing.

- **Grant control** lets that device use the keyboard and mouse; **Revoke control** takes it
  back. One device can control at a time.
- **Disconnect** ends that device's session.
- **Diagnostics** opens live diagnostics in your browser.

### Clients

<p align="center"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../docs/images/windows-host/clients-dark.png">
  <img src="../../docs/images/windows-host/clients-light.png" width="720" alt="Clients: approved clients, nobody waiting for approval">
</picture></p>

Approved clients sign in with their own saved credential, so they can connect again without
a new key, and from the internet when remote access is on.

- **Connect a browser** creates a setup code for a new client (the same dialog as Connect a
  device). The new client then appears under **Needs your approval**: choose **Approve** or
  **Reject**.
- Under **Approved clients**, the list next to each client sets what it may do with the
  keyboard and mouse: **Use Access default**, **Require host approval**, **Allow when
  available** or **View only**. **⋯ > Remove approved client** removes it.
- **Disconnect ordinary sessions now** ends every session that isn't an approved client.

### Access

<p align="center"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../docs/images/windows-host/access-dark.png">
  <img src="../../docs/images/windows-host/access-light.png" width="720" alt="Access: approved clients only, keyboard and mouse allowed when available, up to 4 devices">
</picture></p>

Who may connect and what they may do.

- **Connection method**: **Reusable session key**, **One-time connection keys** or
  **Approved clients only**. With remote access on, only approved clients can sign in.
- **Keyboard and mouse**: **Require host approval** (you grant control in Sessions) or
  **Allow when available** (a viewer takes control when nobody else has it).
- **Connected devices**: how many devices may be connected at once, 1 to 8. Lowering it
  doesn't disconnect anyone.

### Settings

<p align="center"><picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../docs/images/windows-host/settings-dark.png">
  <img src="../../docs/images/windows-host/settings-light.png" width="720" alt="Settings: appearance, public login name and HTTPS">
</picture></p>

- **Appearance**: light, dark or the Windows setting.
- **Public login name**: shown on the sign-in page before anyone signs in, so keep personal
  details out of it. Choose **Save public login name** after changing it.
- **HTTPS**: the certificate's status, where it comes from, when it expires and its
  fingerprint.
- Further down: **Keep sharing when the window closes**, the remote access settings
  (public names or addresses, the public HTTPS port and the media port), **Open logs
  folder**, and the component versions with **Copy versions**.

Closing the window keeps VidVNC running in the notification area unless you turn off **Keep
sharing when the window closes**; right-click its icon for **Quit VidVNC**.

## Layout

| Path                     | What it holds                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `VidVnc.Host.csproj`     | The app project; `npm run build:host` builds it                                                                                                |
| `HostWindow*.cs`         | The window, one file per page or concern (Overview, Displays, Profiles, Sessions, Clients, Access, TLS, the notification-area icon and others) |
| `ServerJob.cs`           | The job object that ends the server's processes with the host, even on a forced exit                                                           |
| `RuntimeManifest.cs`     | Reads the runtime manifest: where Node.js, the server and the media worker are, and the prerequisites                                          |
| `tests/Navigation/`      | The WinUI navigation regression ([README](tests/Navigation/README.md))                                                                         |
| `tests/RuntimeContract/` | Runtime manifest and job object checks (`npm run test:host`)                                                                                   |
