# Native Windows server host

Status: the VidVNC app for Windows, a WinUI 3 app on .NET 10 that owns the PC's
server-management UI and the server process's lifetime. It speaks the
[owner protocol](../../docs/ARCHITECTURE.md#owner-protocol), as the
[Mac host](../macos-host/README.md) does. Installing it is in
[Install and run](../../README.md#vidvnc-app), and building and running it from source in
[Build and run (Windows)](../../README.md#build-and-run-windows): `npm run prepare:host`, then
`npm run start:host`.

| Path                     | What it holds                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `VidVnc.Host.csproj`     | The app project; `npm run build:host` builds it                                                                                                |
| `HostWindow*.cs`         | The window, one file per page or concern (Overview, Displays, Profiles, Sessions, Clients, Access, TLS, the notification-area icon and others) |
| `ServerJob.cs`           | The job object that ends the server's processes with the host, even on a forced exit                                                           |
| `RuntimeManifest.cs`     | Reads the runtime manifest: where Node.js, the server and the media worker are, and the prerequisites                                          |
| `tests/Navigation/`      | The WinUI navigation regression ([README](tests/Navigation/README.md))                                                                         |
| `tests/RuntimeContract/` | Runtime manifest and job object checks (`npm run test:host`)                                                                                   |

## Screenshots

Every page, light or dark to match your GitHub theme, taken from the Debug host by `npm run screenshot:host` ([all images](../../docs/images/README.md)).

<table>
  <tr>
    <td align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="../../docs/images/windows-host/overview-dark.png"><img src="../../docs/images/windows-host/overview-light.png" width="420" alt="Overview"></picture><br>Overview</td>
    <td align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="../../docs/images/windows-host/displays-dark.png"><img src="../../docs/images/windows-host/displays-light.png" width="420" alt="Displays"></picture><br>Displays</td>
  </tr>
  <tr>
    <td align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="../../docs/images/windows-host/streaming-profiles-dark.png"><img src="../../docs/images/windows-host/streaming-profiles-light.png" width="420" alt="Streaming profiles"></picture><br>Streaming profiles</td>
    <td align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="../../docs/images/windows-host/sessions-dark.png"><img src="../../docs/images/windows-host/sessions-light.png" width="420" alt="Sessions"></picture><br>Sessions</td>
  </tr>
  <tr>
    <td align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="../../docs/images/windows-host/clients-dark.png"><img src="../../docs/images/windows-host/clients-light.png" width="420" alt="Clients"></picture><br>Clients</td>
    <td align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="../../docs/images/windows-host/access-dark.png"><img src="../../docs/images/windows-host/access-light.png" width="420" alt="Access"></picture><br>Access</td>
  </tr>
  <tr>
    <td align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="../../docs/images/windows-host/settings-dark.png"><img src="../../docs/images/windows-host/settings-light.png" width="420" alt="Settings"></picture><br>Settings</td>
    <td align="center"><picture><source media="(prefers-color-scheme: dark)" srcset="../../docs/images/windows-host/connect-device-qr-dark.png"><img src="../../docs/images/windows-host/connect-device-qr-light.png" width="420" alt="Connect a device: QR code"></picture><br>Connect a device: QR code</td>
  </tr>
</table>
