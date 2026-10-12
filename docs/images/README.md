# Screenshots

Whole-window screenshots of the VidVNC app, one per page, for the README and other
documents. Each host has its own folder, and both name their files after the page.

| Page                     | Windows ([windows-host/](windows-host/))                      | Mac ([macos-host/](macos-host/))                                                                             |
| ------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Overview                 | [overview.png](windows-host/overview.png)                     | [overview.png](macos-host/overview.png)                                                                      |
| Displays                 | [displays.png](windows-host/displays.png)                     | [displays.png](macos-host/displays.png)                                                                      |
| Streaming                | [streaming-profiles.png](windows-host/streaming-profiles.png) | [streaming.png](macos-host/streaming.png)                                                                    |
| Sessions, Activity       | [sessions.png](windows-host/sessions.png)                     | [activity.png](macos-host/activity.png)                                                                      |
| Clients, Connections     | [clients.png](windows-host/clients.png)                       | [connections.png](macos-host/connections.png)                                                                |
| Access                   | [access.png](windows-host/access.png)                         | [access.png](macos-host/access.png)                                                                          |
| Network                  | (part of Access and Settings)                                 | [network.png](macos-host/network.png)                                                                        |
| Permissions              | (none on Windows)                                             | [permissions.png](macos-host/permissions.png)                                                                |
| Settings                 | [settings.png](windows-host/settings.png)                     | [settings-general.png](macos-host/settings-general.png), [settings-about.png](macos-host/settings-about.png) |
| Connect a device QR code | [connect-device-qr.png](windows-host/connect-device-qr.png)   | [connect-device-qr.png](macos-host/connect-device-qr.png)                                                    |

## Regenerate them

- **Windows:** `npm run screenshot:host` runs [tools/screenshot-host.ps1](../../tools/screenshot-host.ps1)
  against the Debug host from `npm run prepare:host`. It drives the real app, which starts
  sharing, so the images show the PC's name and addresses in Windows' own theme. Close
  VidVNC and any CLI server first.
- **Mac:** [apps/macos-host/docs-screenshots.sh](../../apps/macos-host/docs-screenshots.sh)
  `[light|dark] [scenario]` builds the Debug app and runs it on its sample data
  (`-scenario "Local network"` by default), so no server starts and no real names show.
  `screencapture` takes each window, so the app you run it from (Terminal) needs Screen &
  System Audio Recording; without it the images come out blank. Keep the window on screen
  until VidVNC quits.

The design-review images of the Mac app, light and dark and cropped to the content, are a
separate set in [docs/design/macos-host-previz/](../design/macos-host-previz/README.md).
