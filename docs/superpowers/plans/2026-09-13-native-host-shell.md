# Native host shell implementation plan

**Goal:** Implement the approved native WinUI shell and useful live session status without presenting unsupported capabilities as functional.
**Architecture:** Native NavigationView and bounded content regions; owned stdin/stdout protocol supplies typed session snapshots and disconnect actions. No WebView or extra network administration endpoint.
**Tech Stack:** WinUI 3/C#, Node ESM and node:test.
**Design:** `docs/design/windows-host-previz/README.md` and approved Sessions concept in conversation.

## Scope

Keep existing media behavior and ownership. One-client/primary-display backend remains explicitly labelled. Passkeys, approved-user persistence, QR pairing, multi-monitor selection and simultaneous sessions need separate backend implementation, not fake UI controls. Sharing status must be above Settings. Never expose session tokens over a new HTTP route. Keep footer fixed while content scrolls at smaller sizes.

## Steps

- [ ] Add module-owned tests for `SessionStore.list()` without refreshing expiry, client-device labels, and host snapshot health (unknown/stale/receiving/struggling). Snapshot receives actual active media ID and latest metrics; never apply another session's metrics.
- [ ] Implement `host-status.mjs` and periodic owned-pipe status messages. Process bounded JSON disconnect commands through the existing owner pipe. Keep startup/shutdown protocol compatible.
- [ ] Split WinUI layout into `HostWindow.Layout.cs`; preserve lifecycle in `HostWindow.cs`. Build Overview, Displays, Sessions, Access and Settings native pages. Connect device opens a bounded native dialog with address and session password/copy controls. Show real data and explicit unavailable-feature descriptions.
- [ ] Add a compact session card with optional technical details and Disconnect. Surface control status only when known; do not infer control from session-store defaults.
- [ ] Build Debug host; run portable, host and hardware suites. Verify shell layout and live owner protocol with a real host at a dedicated loopback port. Record remaining gaps.

## Implementation checkpoint

Implemented the native NavigationView shell, all five page surfaces, sharing status above Settings, DPI-scaled initial sizing, fixed footer, bounded content scrolling, connection dialog/copy actions, temporary appearance selection, and log-folder action. Session cards preserve expansion across metric updates and show actual browser platform, address, elapsed connection time, health, stream/profile information and an owned-pipe Disconnect action.

The UI explicitly identifies unsupported capabilities. This is not completion of multi-user/multi-monitor streaming, passkeys, QR pairing, persisted settings, input ownership reporting or host permission enforcement. Those features are not simulated. No web administration endpoint was added.

Verification: Debug build has zero warnings/errors; 56 portable tests pass, eight hardware/system tests pass, and C# runtime/job tests pass. The new integration test connects a real authenticated session, reads it through the host pipe, disconnects it through that pipe and verifies sharing remains available. Native visual inspection was attempted but Computer Use approval timed out; page screenshots, smaller-window/large-text checks and interactive layout acceptance remain outstanding. Test host PID 50708 was stopped; existing user servers were not targeted.
