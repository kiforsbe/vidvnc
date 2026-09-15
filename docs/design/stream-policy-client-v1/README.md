# Stream policy and browser experience — approval previews

Status: web visual direction approved; revised native host previews awaiting approval.
No runtime or application changes.
Generated using the built-in image generation tool; prompts recorded below.

## User requirements

- Previsualize all proposed changes and obtain approval before implementation.
- Host defines permitted output resolutions, frame rates and video bitrates.
- Seed editable/duplicable profiles from the existing profiles, preserving working
  codec/transport defaults. Support custom profiles and host-approved option lists.
- Investigate variable frame rate; do not imply current support.
- Pairing should resemble segmented SMS/email code entry while behaving as one
  accessible text input. Accept paste and optional dash, normalize case, disable
  spellcheck/autocorrection, preserve caret/selection/backspace and keyboard access.
- Preserve the video area, aspect ratio, fullscreen/input behavior and existing
  flush-top overlay. Redesign surrounding browser UI with iCloud-like polish,
  responsive layout, platform system typography and accessible controls.
- Continue selectable-display roadmap with server-enforced authorization.
- Native host remains WinUI 3, not a web or Apple-styled replacement.

## Proposed host behavior

Host permits either approved named profiles only, or client customization from
explicit resolution/frame-rate/bitrate option lists under host limits. Clients
cannot override policy. Validate combinations against source aspect ratio and
runtime capabilities, not just individual list membership. Resolution describes
stream output bounds, never changes the physical monitor's mode.

The first preview shows a maximum bitrate field; detailed editing must ALSO
expose an approved bitrate list (for example 1, 2, 4, 6 Mbit/s) and Add/Edit options
for all three lists. That field is not a substitute for the requested list.

Use existing seeds: iPhone 1280x720/15/1000; mobile 1280x720/15/2000;
balanced 1920x1080/30/4000; desktop 2560x1440/30/6000;
low-bandwidth 960x540/15/1000 (bitrates in kbit/s).
Automatic selects among allowed compatible profiles; it is not congestion control.
Host audio permission is an upper bound; clients may mute or decline permitted
audio but may not enable audio denied by the host.

Proposed variable delivery: an approved upper frame-rate cap with fewer frames
during inactivity, not a guarantee of constant delivery or display VRR.
Keep existing fixed profiles initially; variable delivery remains disabled without
warning badges until capture timestamps, encoder behavior, recovery, audio sync and
iPhone playback are verified. The source documentation advertises a framerate
range, which does not establish reliable end-to-end variable delivery:
https://gstreamer.freedesktop.org/documentation/d3d11/d3d11screencapturesrc.html

Apply validates and persists policy atomically. Report affected sessions before
a required restart; revocation must stop unauthorized media/input. Detailed
switching/rollback behavior remains in the display-selection design.

## Preview scope and corrections

- host-stream-policy-v1.png: Windows profile catalog, selected profile editor and
  host-controlled allowed options. This is a detail view under Displays; preserve
  existing navigation, bottom Settings/sharing placement and title bar in code.
- web-pairing-v1.png: desktop/mobile pairing and error state. Use eight visual cells
  over one semantic input, not eight independently focusable inputs. Sample letters
  are fictional. No display inventory before authentication. Do not create dead
  Help/Privacy/Support links merely because the generated mockup included them.
- web-viewer-v1.png: display picker, existing stage/overlay, compact quality and
  connection details. Generated mobile stage proportions are illustrative: retain
  actual source aspect ratio without stretching/cropping in implementation.
  Keep overlay sizing and behavior from existing code, not generated approximation.
- Generated domains, browser padlocks and marketing text are not requirements.
  The current LAN HTTP pairing limitation must remain truthfully communicated.
- Labels showing resolution/fps must distinguish negotiated targets from measured
  delivery. “Best for your connection” is not an implemented adaptive guarantee.
- Web visual direction approved by the user. Support light and dark themes;
  default to system appearance when available, including live system changes.
  Use a light fallback when no preference is exposed. Any manual theme selection
  should offer System, Light and Dark, and persist only the user's explicit choice.
  Theme the surrounding UI, not the streamed desktop; preserve overlay contrast.
- The original host split-pane preview is superseded by the v2 previews below.

## Revised native host direction

- Add a dedicated **Streaming profiles** navigation entry immediately after Displays.
- Full-width profile list, with + New profile and per-row ellipsis menus offering
  Edit, Duplicate and Remove. No persistent right-hand profile editor.
- Create/edit uses the same native ContentDialog. Validate before Save; Cancel
  leaves the profile unchanged. Removing a referenced profile needs reassignment
  or explicit confirmation of consequences, never dangling defaults.
- Displays chooses a global default profile. Each display either inherits it
  (shown as Use default with the effective name) or selects an explicit override.
- A permitted explicit client request takes precedence over a default. Otherwise
  use the display override, then the global default, subject to capabilities and
  host permission. Defaults are not permission grants.
- Per-display allowed-profile lists are a later capability. Show the planned
  control disabled without a coming-soon label until backed by policy enforcement.
- Retain existing titlebar and sharing-status behavior; the generated sidebar
  switch is not a request to replace the existing status indicator.
- Revised artifacts: streaming-profiles-v2.png, profile-editor-modal-v2.png,
  displays-profile-defaults-v2.png. Await user approval before implementation.
- The modal's generated background profiles are illustrative and inaccurate:
  retain existing profile seeds listed above. Resolution choices must allow
  custom values, not only the single example shown by the closed dropdown.

## Approval-to-implementation sequence

1. Approve/refine these directions and the detailed allowed-options editor.
2. Reconcile roadmap and existing plan with completed inventory/UI work and these
   requirements; define policy/request/effective-plan contracts.
3. Implement host policy plus authenticated selectable-display capture/input.
4. Implement approved pairing and surrounding viewer redesign, preserving player.
5. Connect quality editing end to end; separately test variable-rate delivery.
6. Test two real monitors and iPhone/desktop regressions before concurrency work.

## Generation prompts

### host-stream-policy-v1.png

Use case: ui-mockup. Create a polished high-fidelity UI design approval board for VidVNC, a real Windows 11 WinUI3 native desktop host application. Landscape 1800x1200-ish. Flat front-on screenshot, NOT perspective hardware. Show one native dark Mica window with genuine Windows titlebar caption buttons, Segoe UI, compact 24px page gutters, 16px card insets, 12px row insets, thin separators, properly aligned native controls. Sidebar Overview, Displays selected, Sessions, Access, Settings. Main content title 'Streaming profiles'. Two-thirds left panel: 'Available to clients', compact rows with enabled checkbox, profile name and numerical summary: 'iPhone · 720p / 15 fps / 1 Mbit/s'; 'Mobile · 720p / 15 fps / 2 Mbit/s'; 'Balanced · 1080p / 30 fps / 4 Mbit/s' selected blue; 'Desktop · 1440p / 30 fps / 6 Mbit/s'; 'Low bandwidth · 540p / 15 fps / 1 Mbit/s'. Buttons 'New profile' and 'Duplicate'. Lower card 'Client customization' shows radio choices 'Approved profiles only' and selected 'Approved options'; compact checkbox chips '540p' '720p' '1080p' '1440p' and '15 fps' '30 fps'; 'Maximum video bitrate' spinner '6 Mbit/s'. 'Allow desktop audio' native switch On. Right detail pane 'Balanced', field Name Balanced, 'Output size' 1920 x 1080, 'Frame rate' 30 fps, 'Video bitrate' 4 Mbit/s. 'Frame delivery' segmented choices Fixed selected and Variable disabled grey WITHOUT not-implemented badges. Short note 'Output fits the selected display. Local resolution stays unchanged.' Footer small 'Host limits apply to every client.' Cancel and blue 'Apply'. All text readable, no developer jargon, no fake performance dashboards, no giant whitespace, no Apple styling in Windows. This is an approval concept, not a screenshot of implemented functionality. Host owns permitted options; clients cannot exceed limits.

### web-pairing-v1.png

Use case: ui-mockup. High-fidelity design approval board for VidVNC web pairing, modern premium iCloud-inspired simplicity but original VidVNC identity, no Apple logo. Two adjacent flat front-on layouts on soft pale grey background: desktop browser page on left about 1000px wide and portrait mobile web page on right about 390px wide. White/light surfaces, extremely restrained icy blue background glow, dark crisp system typography, subtle borders, accessible blue buttons, confident clean spacing, no huge marketing slogan. Desktop thin header small monitor logo 'VidVNC'. Center modest white pairing card: monitor glyph, 'Connect to Thor', 'Enter the session password shown on your computer.' label 'Session password'. Exactly EIGHT letter slots, arranged four plus a small separator gap plus four, letters A B C D E F G H as fictional sample. They look like eight rounded square cells but have ONE overall focus outline and ONE caret in final cell, conceptually one native text entry not eight inputs. Blue 'Connect' button. Small 'No dash needed. You can paste the whole password.' Under card small truthful 'Use only on a trusted network.' No fake TLS lock, no claim end-to-end authentication, no passkey button. Mobile same hierarchy fits width: eight compact slots in one row four-and-four, large tappable Connect button. Include a small alternate-state strip below desktop card showing same eight slots empty and inline red text 'Password not recognized. Try again.' Keep readable, professional, native system font feeling on each platform. No quality/profile/displays exposed before authentication. No real credentials.

### web-viewer-v1.png

Use case: ui-mockup. Create high-fidelity responsive web viewer design approval board for VidVNC, iCloud-inspired calm modern web UI, professional original brand no Apple logo. Landscape board two clear front-on browser layouts desktop large left and phone portrait right. White/light pearl background, restrained blue accent, subtle borders, platform system typography. Desktop page thin top bar small monitor logo VidVNC, 'Thor' with green connected dot, right understated 'Disconnect'. Below small display choice chips '1 Main display' selected, '2 Second display'. Main central 16:9 VIDEO surface containing a tasteful blue Windows desktop wallpaper and small ordinary application window; actual video rectangle must have exact matching stage dimensions with no surrounding tall blank stage or cropped video. Preserve existing player overlay semantics and appearance: tiny dark translucent rounded-bottom icon toolbar attached flush TOP CENTER of video, ZERO GAP above it; keyboard/mouse icon, speaker icon, divider, fullscreen icon. Not a floating toolbar elsewhere. No new controls inside the video. Below video one compact row 'Main display' '1280 × 720 · 15 fps', right 'Quality: Automatic' disclosure and details icon. Lower small expandable 'Connection details', no dashboard clutter. Open quality popover beside lower row displays 'Allowed by Thor' with Automatic selected, iPhone 720p, Balanced 1080p; an Advanced disclosure for host-approved options. Mobile layout same shell, stacked display picker and landscape 16:9 video fitting phone width, same flush-top icon overlay, compact quality row below. Enough tappable spacing, no giant headers, no obligatory sidebar. Show video aspect ratio faithfully. This is a proposed surrounding-shell redesign only; playback element, fullscreen/input release behavior and overlay are to be retained in implementation.

