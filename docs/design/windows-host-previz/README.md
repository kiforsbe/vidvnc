# Windows host page previews

Generated with the built-in image tool. These are future-product UX concepts, not evidence of implemented functionality. Example devices, passkeys, approval, multi-monitor and multi-session data are illustrative. Sharing status sits above Settings. Opening at sign-in should not implicitly grant remote access; final behavior requires a separate explicit sharing preference.

## Identify displays

Approved on 2026-09-14: [identify-v1.png](identify-v1.png). Show a compact numbered
dark label near the bottom-left of each current physical monitor for three seconds.
Use the same numbering as Displays. No focus stealing, task-switcher entry, screen
capture or monitor-setting changes. Replace labels on repeated invocation and
dismiss them when inventory changes, sharing stops or the host closes. Position
inside the monitor work area so labels do not cover its taskbar.

## Closing the window

Decided on 2026-10-11 and implemented in
[HostWindow.Tray.cs](../../../apps/windows-host/HostWindow.Tray.cs): closing the host window
hides VidVNC to the notification area (system tray) and sharing carries on. The tray icon is a
monochrome outline glyph like Windows' own notification-area icons (white on a dark
taskbar, black on a light one, reloaded when the theme or DPI changes); its tooltip and
menu show the sharing state; selecting it opens the window, and its menu offers
Open VidVNC, Start or Stop sharing and Quit VidVNC. Only Quit (or signing out) ends the
server. **Keep sharing when the window closes** in Settings, on by default, can be turned
off so that closing the window stops sharing; VidVNC stays in the notification area either
way. This matches the macOS host, which stays in the menu bar
([prototype](../../../apps/macos-host/README.md#ui-prototype)).

### Tray icon

The tray icons follow the same conventions as the tray icons of
[Agenda](https://github.com/kiforsbe/agenda) (its `scripts/create-assets.ps1`), so the two
apps look alike in the notification area: each size (16, 20, 24, 32, 40, 48 and 64 px) is
drawn separately, strokes are size/16 px wide on the pixel grid with anti-aliasing off, the
ink is white for a dark taskbar and RGB 26,26,26 for a light one, and the entries are
uncompressed 32-bit DIBs. The glyph is drawn like the monitor in Windows' network icon: a
rectangular frame with only the outermost corner square left out, on an open stand of two
legs and a foot, with the Fluent share-screen arrow inside it. The frame's width has the same parity as the stroke, so the arrow, its head and
the stand share one exact centre column, and the arrow has equal space above and below it
in the screen; the generator fails if any size's glyph isn't mirror-symmetric. The Windows host embeds that "sharing" glyph as
`apps/windows-host/Assets/VidVnc.tray-on-dark.ico` and `VidVnc.tray-on-light.ico` and shows
it in every state; the tooltip says the state.

[tray/preview.png](tray/preview.png) also proposes a version for each state: a plain
outline when sharing is off, and 7×7 pixel badges in the lower-right corner, cut out with a
one-pixel gap like the check on Windows' Safely Remove Hardware icon: a globe for remote
access, a pointer when someone is controlling, an amber dot when something needs attention
(an approval or a new network) and a red cross when the server stopped unexpectedly. Only
the warning badges use colour. These match the macOS menu bar states; the Windows host
doesn't switch between them yet.

[tray/make-tray-icons.swift](tray/make-tray-icons.swift) writes all of these (the per-state
`.ico` files, the preview and the two host icons) on a Mac:
`swift docs/design/windows-host-previz/tray/make-tray-icons.swift`.

## Session stability addition

Approved layout: [session-stability-v1.png](session-stability-v1.png). Compact stream
details on the left, inline 60-second graph on the right, no nested graph card.
The user's follow-up supersedes the single trace in that mockup: plot capture,
encode, and decode FPS on one shared scale using the same timestamped sources as
web Diagnostics. Preserve missing-data gaps rather than inventing zeroes or
interpolating across missing samples. At narrow widths the graph wraps below.

Markers report interval changes in frame drops, freezes, and PLI/FIR recovery
requests; recovery requests do not claim successful recovery. Hover/tap exposes
interval details, packet loss, RTT, and jitter. History is bounded to the current
session and latest minute. Light/dark palettes retain distinct traces and shapes.
The Sessions header opens the local Diagnostics page at the active server port.

## overview

![overview](overview-v1.png)

Prompt:

Use case ui-mockup. Generate one high-fidelity native Windows 11 WinUI 3 VidVNC HOST application concept. The attached image is a STYLE AND SHELL REFERENCE, not content to copy. Preserve its window proportions, charcoal Mica, Segoe UI, blue accent, authentic Windows titlebar and Fluent line icons. Landscape complete window, crisp readable type. No browser chrome, no POC, no developer dashboard. Left navigation Overview, Displays, Sessions, Access; IMPORTANT bottom sidebar must have green dot 'Sharing is on' ABOVE 'Settings' which is the bottom-most item. Select the requested page only. Fixed window size, all content and footer visible. This is a future full-product UX concept, illustrative state not a working feature claim. Page Overview. Heading 'Overview', subtitle 'Your desktop, ready to share'. Top right blue 'Connect a device'. Compact status card 'Thor' with green 'Sharing is on', 'Available on your local network', secondary 'Stop sharing'. Below single understated summary row '3 connected devices · 5 display streams · 1 controlling', link 'View sessions'. Midpane 'Shared displays' with two modest monitor representations landscape 1 'Main display' and portrait 2 'Portrait display', link 'Manage displays'; NOT massive thumbnails. Lower pairing card phone icon, 'Connect your iPhone or another device', text 'Scan a QR code or open a connection link.', primary small 'Show QR code', secondary 'Copy connection link'. Do not render an actual QR. Bottom informative unobtrusive line 'New devices need approval. Manage access'. Compact refined WinUI layout.

## displays

The approved flat-settings revision is [displays-flat-defaults-v2.png](displays-flat-defaults-v2.png).
It supersedes nested Host defaults and display-detail cards: use flat setting rows
with separators, profile selectors instead of independent quality/fps controls,
and footer Apply/Cancel. Unsupported per-display allowed-profile selection stays
disabled without a placeholder label.

![displays](displays-v1.png)

Prompt:

Use case ui-mockup. Generate one high-fidelity native Windows 11 WinUI 3 VidVNC HOST application concept. The attached image is a STYLE AND SHELL REFERENCE, not content to copy. Preserve its window proportions, charcoal Mica, Segoe UI, blue accent, authentic Windows titlebar and Fluent line icons. Landscape complete window, crisp readable type. No browser chrome, no POC, no developer dashboard. Left navigation Overview, Displays, Sessions, Access; IMPORTANT bottom sidebar must have green dot 'Sharing is on' ABOVE 'Settings' which is the bottom-most item. Select the requested page only. Fixed window size, all content and footer visible. This is a future full-product UX concept, illustrative state not a working feature claim. Page Displays. Heading 'Displays', subtitle 'Choose which screens are available to connected devices'. Top right 'Identify displays' neutral button. Compact monitor arrangement diagram landscape rectangle numbered1 left and portrait rectangle numbered2 right, both blue subtle borders, exact different orientations. Below two native setting cards: 'Main display' badge 'Primary', '2560 × 1440 · 60 Hz', sharing ToggleSwitch On; second 'Portrait display', '1080 × 1920 · 60 Hz', sharing ToggleSwitch On. Small subordinate text 'Clients choose which shared displays to view.' Lower section 'Streaming defaults', native settings rows 'Quality' dropdown 'Automatic', 'Frame rate' dropdown 'Automatic', 'Desktop audio' ToggleSwitch On. Footer help text 'Stream quality adapts per client. Your local display settings stay unchanged.' Do not imply the host controls arrangement of physical client monitors. Native tasteful compact controls.

## access

![access](access-v1.png)

Prompt:

Use case ui-mockup. Generate one high-fidelity native Windows 11 WinUI 3 VidVNC HOST application concept. The attached image is a STYLE AND SHELL REFERENCE, not content to copy. Preserve its window proportions, charcoal Mica, Segoe UI, blue accent, authentic Windows titlebar and Fluent line icons. Landscape complete window, crisp readable type. No browser chrome, no POC, no developer dashboard. Left navigation Overview, Displays, Sessions, Access; IMPORTANT bottom sidebar must have green dot 'Sharing is on' ABOVE 'Settings' which is the bottom-most item. Select the requested page only. Fixed window size, all content and footer visible. This is a future full-product UX concept, illustrative state not a working feature claim. Page Access. Heading 'Access', subtitle 'Decide who can connect and what they can do'. Top right primary 'Add access'. Compact section 'Connection policy': 'Approve new devices' ToggleSwitch On; 'Default permission' dropdown 'View only'. Helper 'You can grant keyboard and mouse control during a session.' Section 'Approved devices', two compact real-looking illustrative rows: phone icon 'Kim’s iPhone', subtext 'Kim · Passkey', permission 'View only', menu ellipsis; laptop icon 'Kim’s MacBook Pro', subtext 'Kim · Passkey', permission 'Can request control', menu ellipsis. Section 'Sign-in methods' native row key icon 'Passkeys', subtitle 'Sign in using a trusted phone or device', right 'Manage'; native row 'Temporary access code', subtitle 'For a one-time connection', right 'Generate code'. Restrained bottom info 'Only one device controls the shared desktop at a time.' No sample passwords, no QR, no giant avatars, no claims of secure HTTP.

## settings

![settings](settings-v1.png)

Prompt:

Use case ui-mockup. Generate one high-fidelity native Windows 11 WinUI 3 VidVNC HOST application concept. The attached image is a STYLE AND SHELL REFERENCE, not content to copy. Preserve its window proportions, charcoal Mica, Segoe UI, blue accent, authentic Windows titlebar and Fluent line icons. Landscape complete window, crisp readable type. No browser chrome, no POC, no developer dashboard. Left navigation Overview, Displays, Sessions, Access; IMPORTANT bottom sidebar must have green dot 'Sharing is on' ABOVE 'Settings' which is the bottom-most item. Select the requested page only. Fixed window size, all content and footer visible. This is a future full-product UX concept, illustrative state not a working feature claim. Page Settings. Heading 'Settings', subtitle 'Make VidVNC work your way'. Selected bottom-most Settings row with status Sharing is on immediately ABOVE it. Native stacked settings cards grouped 'General': 'Appearance' dropdown 'Use system setting'; 'Start VidVNC when I sign in' ToggleSwitch Off; 'When I close the window' dropdown 'Stop sharing and exit'. Group 'Connection': 'Network access' dropdown 'Local network only'; 'Connection port' compact numeric field '4382'; small info 'Remote connections are not enabled.' Group 'Support': 'Logs and troubleshooting' chevron row; 'About VidVNC' chevron row. Bottom subdued text 'Changes that interrupt sharing will ask for confirmation.' No Apply button unless needed, no codec jargon, no debug output, no giant blank areas. Clear normal native font and icon hierarchy.
