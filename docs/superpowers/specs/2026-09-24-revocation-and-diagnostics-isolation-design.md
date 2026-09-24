# F2/F4/F5 follow-up security design

Approved 2026-09-24 for implementation on main. This supersedes the F2/F4/F5 implementation details in the [selected hardening design](2026-09-23-selected-internet-exposure-hardening-design.md), not its F1/F7 decisions. The [security status](../../security/internet-exposure-hardening-status-2026-09-24.md) remains the release-status source.

## F2: active-client permission changes

An owner removal or permission edit first invalidates the approved client's admission generation and synchronously disconnects **every** matching server session. After this point, prior bearers cannot start HTTP requests, signaling, input grants, or stream subscriptions. This includes view-only changes and permission upgrades; clients may sign in again only under the newly persisted permission. Any already-running request must recheck its session before returning protected data after an asynchronous operation.

The owner command then awaits stream/native teardown for each affected session and durable permission persistence before reporting success. Control denial is fail-closed: if native acknowledgment or peer termination cannot be established, stop sharing and report an error. Shutdown also invalidates all surviving sessions. No guarantee can undo input processed before the edit reached the server.

## F4: independent local diagnostics service

The public-capable plaintext and HTTPS listeners have no diagnostics page, API, or diagnostics-only static-asset routes, including for loopback callers or valid capabilities. They return 404 without redirecting such paths. A separate HTTP server binds only `127.0.0.1` on an OS-selected port and exclusively serves the diagnostics page, required assets, and API. It has the same explicit owner-issued 256-bit, short-lived bearer gate on the API, defensive Host/socket checks, no CORS, and no URL/cookie bearer admission. Binding failure aborts startup; shutdown closes the private listener.

The owner pipe's explicit diagnostics-capability reply includes this listener's local URL and the token. The CLI `diagnostics open` uses the same local URL. The Windows host validates the returned loopback URL before launching it; it does not derive diagnostics from the preview address. Routine ready/status and network address lists never disclose a diagnostics URL or bearer.

A same-host proxy deliberately configured to forward the private port remains a deployment error, and a stolen unexpired bearer can still be replayed. This change ensures the ordinary public service port cannot route diagnostics.

## F5: browser/client credential vocabulary

The approved-client secret stored by a browser is an additional, copyable **client credential** alongside username and password. It is not a device secret, physical-device identity, or device-binding proof. Keep storage and wire names compatible, but relabel user-facing registration and host management copy accordingly. One live session per credential, revocation, and the F2 teardown above limit but do not prevent copying. Remote release still requires an explicit acceptance of this model for its topology.

## Acceptance

- During an intentionally delayed native teardown, old affected session bearers already receive 401; ordinary/other-client sessions remain live. No host success is reported until teardown and persistence complete.
- Protected asynchronous request paths do not return successful data after mid-request disconnect.
- With or without active TLS, `/diagnostics`, `/api/diagnostics`, and diagnostics-only assets on the public-capable app return 404 even with a valid bearer and loopback Host. The private bound listener remains usable only through its explicit owner-issued link.
- CLI, desktop host, startup exercise, and security documentation agree on the separate URL and the client-secret identity model.
