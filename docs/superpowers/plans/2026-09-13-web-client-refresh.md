# Approved web client refresh

References: `docs/design/stream-policy-client-v1/web-pairing-v1.png` and
`web-viewer-v1.png`. Existing player and overlay are authoritative.

Implement in this checkout, without subagents:

1. Single semantic password input with eight visual cells and a permanent central dash, editable selection,
   paste, normalization, inline errors and no secret persistence.
2. Responsive light/dark shell; system default, explicit appearance choice.
3. Authenticated host-approved profile catalog and radio-list quality selection.
   Selecting Automatic or a named profile immediately restarts the stream using a rotated session token;
   validate before teardown, await worker exit, preserve host policy enforcement.
4. Compact connected header, actual primary-display chip, target metadata,
   disclosed quality/audio settings and connection details. Do not invent secondary
   display support, automatic adaptation or secure HTTP pairing claims.
5. Use available viewport width with 4px outer margins, limited only by available
   viewport height while preserving video aspect ratio. Preserve media elements, WebRTC codecs, separate audio,
   top-flush overlay and keyboard/fullscreen shortcuts. Shell controls must not
   send keystrokes to the remote desktop.

QA: real HTTP authentication/catalog/reconnect tests; input normalization tests;
browser typing, selection, invalid password/retry, 390px and 320px width, system
theme changes and manual overrides; actual browser WebRTC test-pattern reception;
quality reconnect, host-denied choices, mute, release, fullscreen/auto-hide;
desktop/mobile light/dark screenshots. Browser fixture is not real iPhone/GPU
acceptance. Keep the user's running server untouched; own test processes close.

## Clarified Automatic behavior — follow-up implementation

The web client offers only Automatic and enabled named profiles. No manual custom
resolution, frame-rate or bitrate controls are exposed.

Host-approved option lists define the search space for Automatic to adapt during
a session. In approved-profiles-only mode, Automatic must stay within enabled
profiles. In approved-options mode, it may test validated combinations of the
allowed resolutions, frame rates and bitrates. Explicit named selections remain
fixed until the user selects Automatic again. Host audio permission remains an
independent hard limit.

Current limitation: Automatic resolves a starting profile only. It does not yet
run an adaptive controller. That next implementation must evaluate sustained
receiver frame delivery, freezes, loss/retransmissions, jitter and transport
buffering; distinguish network pressure from decode stalls; back off promptly,
probe upward cautiously, and use cooldowns to prevent oscillation. It must
revalidate host policy for every change and expose the effective stream settings.
Avoid frequent full reconnects as a substitute for live encoder reconfiguration;
verify which worker settings can change live and clearly identify those that
require a stream restart. Validate against the iPhone and sender-burst regression.
