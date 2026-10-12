# Screenshots

Whole-window screenshots of the VidVNC app, one per page in light and dark, for the README
and other documents. Each host has its own folder, and both name their files after the page,
then `-light` or `-dark`.

| Page                     | Windows ([windows-host/](windows-host/))                                                                                  | Mac ([macos-host/](macos-host/))                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Overview                 | overview ([light](windows-host/overview-light.png), [dark](windows-host/overview-dark.png))                               | overview ([light](macos-host/overview-light.png), [dark](macos-host/overview-dark.png))                            |
| Displays                 | displays ([light](windows-host/displays-light.png), [dark](windows-host/displays-dark.png))                               | displays ([light](macos-host/displays-light.png), [dark](macos-host/displays-dark.png))                            |
| Streaming                | streaming-profiles ([light](windows-host/streaming-profiles-light.png), [dark](windows-host/streaming-profiles-dark.png)) | streaming ([light](macos-host/streaming-light.png), [dark](macos-host/streaming-dark.png))                         |
| Sessions, Activity       | sessions ([light](windows-host/sessions-light.png), [dark](windows-host/sessions-dark.png))                               | activity ([light](macos-host/activity-light.png), [dark](macos-host/activity-dark.png))                            |
| Clients, Connections     | clients ([light](windows-host/clients-light.png), [dark](windows-host/clients-dark.png))                                  | connections ([light](macos-host/connections-light.png), [dark](macos-host/connections-dark.png))                   |
| Access                   | access ([light](windows-host/access-light.png), [dark](windows-host/access-dark.png))                                     | access ([light](macos-host/access-light.png), [dark](macos-host/access-dark.png))                                  |
| Network                  | (part of Access and Settings)                                                                                             | network ([light](macos-host/network-light.png), [dark](macos-host/network-dark.png))                               |
| Permissions              | (none on Windows)                                                                                                         | permissions ([light](macos-host/permissions-light.png), [dark](macos-host/permissions-dark.png))                   |
| Settings                 | settings ([light](windows-host/settings-light.png), [dark](windows-host/settings-dark.png))                               | settings-general ([light](macos-host/settings-general-light.png), [dark](macos-host/settings-general-dark.png))    |
|                          |                                                                                                                           | settings-about ([light](macos-host/settings-about-light.png), [dark](macos-host/settings-about-dark.png))          |
| Connect a device QR code | connect-device-qr ([light](windows-host/connect-device-qr-light.png), [dark](windows-host/connect-device-qr-dark.png))    | connect-device-qr ([light](macos-host/connect-device-qr-light.png), [dark](macos-host/connect-device-qr-dark.png)) |

The [website](../../site/README.md) shows copies of some of them, and a hero image drawn from
the two `overview` screenshots; after regenerating, update those as its README says.

`overview-light.png` and `overview-dark.png` here are the README's top image: both Overview
pages over a gradient, drawn from the light and dark screenshots above.

## Regenerate them

- **Windows:** `npm run screenshot:host` runs [tools/screenshot-host.ps1](../../tools/screenshot-host.ps1)
  against the Debug host from `npm run prepare:host`. It drives the real app, which starts
  sharing, so the images show the PC's name and addresses. It switches Settings > Appearance
  to Light, then Dark (`-Themes Light` for one); that choice isn't saved. Close
  VidVNC and any CLI server first.
- **Mac:** [apps/macos-host/docs-screenshots.sh](../../apps/macos-host/docs-screenshots.sh)
  `[light|dark|both] [scenario]` builds the Debug app and runs it on its sample data
  (`-scenario "Local network"` by default), so no server starts and no real names show.
  `screencapture` takes each window, so the app you run it from (Terminal) needs Screen &
  System Audio Recording; without it the images come out blank. Keep the window on screen
  until VidVNC quits.
- **The README's top image:** after either set changes, `swift tools/readme-hero.swift` on a
  Mac redraws it from the two `overview` screenshots.

The design-review images of the Mac app, light and dark and cropped to the content, are a
separate set in [docs/design/macos-host-previz/](../design/macos-host-previz/README.md).
