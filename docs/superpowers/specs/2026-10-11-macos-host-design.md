# macOS host app design

Date: 2026-10-11. Status: accepted by the owner on 2026-10-11, built in plan phase 5.

This note records the host app design the owner accepted (the "VidVNC for Mac: host app
design proposal" document) and how phase 5 of the
[macOS plan](../plans/2026-10-09-macos-support.md) carried it out. It replaces the page list
in the plan's task 5.4; the plan itself is not edited.

## Decisions

- **Sections, not Windows pages.** The window has a sidebar with Overview, Displays,
  Connections, Access, Network, Activity and Permissions (Displays moved up at the owner's
  request; Overview shows its displays strip above Connection Details too). Streaming profiles, allowed options,
  the encoder and codecs go to the Settings window (Streaming tab), with General (open at
  login, keep sharing when the window closes, logs) and About (versions). Parity with Windows
  is kept function by function, not page by page.
- **Sharing control.** A switch on Overview, a status line in the sidebar footer, and a menu
  bar item that starts and stops sharing with the window closed. The Overview stop button of
  the mockups is dropped in favour of the switch and **Connect a Device**.
- **Closing the window** keeps sharing running from the menu bar item, unless **Keep sharing
  when the window closes** is off.
- **Settings apply when changed**, except where Windows asks before disconnecting viewers:
  display and streaming changes ask first when devices are connected.
- **Permissions are a section**: Screen & System Audio Recording, Device Control & Data
  Access, Local Network and new-network confirmation, each with its live state and a way to
  System Settings. Nothing is asked at launch (spec D5).
- **The prototype became the app.** The views read a `HostModel` protocol; `FakeHostModel`
  stays for previews, screenshots and the Debug `-scenario` switch, and `ServerHostModel`
  speaks the owner protocol.

## Mapping to the owner protocol

No protocol change was needed. The app reads `ready`, `status`, `clients` and `displays`
and sends every command in the contract: `access-set`, `policy-set`,
`session-command`, `disconnect`, the three code commands, both client commands,
`ordinary-sessions-disconnect`, `network-confirm`, `diagnostics-capability-create` and
`tls-regenerate`. While sharing is off it uses the offline `config` command, as Windows does.

## Deviations from the plan

| Plan task | What changed                                                                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5.2       | No capture-helper target yet: the helper bundle wraps the CMake-built worker and carries its own provisioning profile, so it is assembled by packaging (phase 6) with the bundled Node.js. |
| 5.4       | Seven sections and a Settings window instead of eleven pages, as above.                                                                                                                    |
| 5.5       | The Local Network state is inferred by browsing for `_vidvnc._tcp`; macOS has no API to read it.                                                                                           |
| 5.6       | Deferred to packaging: **Install command-line tool** links the bundled `Helpers/vidvnc`, which exists only in a packaged app.                                                              |

The design's "confirmed networks with Forget" list is not built: the server reports only the
networks waiting for an answer, and adding a list would be a protocol change.
