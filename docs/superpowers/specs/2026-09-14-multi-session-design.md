# Multiple sessions and streams

Approved direction: user delegated detailed decisions on 2026-09-14 after the
Sessions preview. Keep the existing checkout and commit after the whole milestone.

## Model and boundaries

An authenticated session represents one device. Each session owns independently
identified display streams. A stream owns its worker, profile, source, recovery
state and bounded diagnostics. Stream IDs are not credentials: the session bearer
must authorize every stream operation. Default admission allows two sessions,
two video streams per session and four video workers host-wide, plus one audio-only
worker per session (six processes maximum). Reserve capacity before
asynchronous startup, including stopping workers until OS exit. Encoder failures
reject only the affected stream; do not silently lower explicit profiles.

Use independent encoders first; shared capture/encode optimization is deferred.
Apply conservative aggregate bitrate and pixel-rate budgets before spawning.
One audio delivery belongs to each session, independent of video subscriptions;
adding a display must not start a second audio mix. Each stream can independently
stop, switch or fail. Removing a display stops only its affected subscriptions.

## Input

Clients start view-only. Host grant/revoke uses the existing owned administration
pipe, not an unauthenticated HTTP endpoint. Only one device owns control at once,
and only its selected stream can inject. Native workers enforce server-issued
permission separately from the client's local keyboard/mouse toggle. Transfer
releases held keys/buttons before another worker is authorized. Permission expires
on lost heartbeat, disconnect, stream replacement, shutdown or host revoke.
Revoked clients cannot re-enable themselves over a data channel.

## UI

Preserve the approved native Sessions design: one expander per device; flat rows
for its display streams; an independent Capture/Encode/Decode graph per row;
session-level audio; Grant control/Revoke control and explicit Disconnect.
Keep stable visual objects across metric ticks. Stream stop differs from device
disconnect. Diagnostics supports selecting a stream without mixing histories.
Web retains the selected display video and overlay, with subscriptions scoped to
the device and accessible stream selection; iPhone keeps width/height fitting.

## Acceptance

Two authenticated clients with different profiles, concurrent two-display
subscriptions, correct source/input routing, no duplicated audio, isolated
reconnect/teardown/failure/metrics, atomic bounded admission, owner transfer and
revoke enforcement, zero remaining owned subprocesses after exit. Regression:
existing password, profile, display policy, compact UI and iPhone behavior.
Hardware acceptance is recorded separately from synthetic test evidence.
