# Public login and protected viewer boundary

Design agreed in conversation on 2026-09-25; written specification awaiting owner review. This addresses the public-web-page information exposure identified in the [Internet exposure review](../../security/internet-exposure-review-2026-09-24.md). It does not, by itself, approve Internet deployment.

## The remaining problem

Today an unauthenticated visitor can download the combined login/viewer HTML and its monolithic JavaScript. `GET /api/info` also reveals the operating-system hostname, connection mode, stream/media capabilities, and profile names. These do not grant a desktop session, but they disclose host-specific information and protected viewer implementation details before sign-in. The intended boundary is: **before login, only the public identity and code needed to log in; after login, viewer assets and private host details**.

An attacker will still see that VidVNC and its public admission routes exist. Endpoint names cannot be made secret while a browser must call them. Authorization of the APIs, short-code controls, and transport policy remain the security controls; asset separation reduces unnecessary disclosure and reconnaissance.

## Scope and non-goals

- Split the public login shell from viewer-specific HTML, JavaScript, and CSS; require an active session for every viewer asset request.
- Reduce anonymous `GET /api/info` to an owner-chosen public display name. Move no private data into another anonymous response.
- Keep the existing approved-client and connection-key flows, authenticated bearer API, WebRTC behavior, explicit LAN-only HTTP mode, and restrictive content-security policy working.
- Preserve immediate F2 revocation across the new viewer-asset grant. This is not a replacement for the existing session bearer or a new device credential.
- Do not expose host administration or diagnostics on the public listener. Do not claim that hiding client code makes a remotely exposed service safe.

## Route and data boundary

| Request | Anonymous result | After admission |
| --- | --- | --- |
| `GET /` and public login assets | Login forms, generic instructions, and only the code required for key/approved-client admission. No viewer markup, viewer module import, private route inventory, display/profile data, or media readiness. | Still the public login shell. |
| `GET /api/info` | Exactly `{ "publicName": "…" }`, with `Cache-Control: no-store`. | Same minimal public response; private details come from authenticated APIs. |
| Public admission/status endpoints | Remain available as required to authenticate, subject to existing source/origin, rate, code-expiry, and permission checks. Their errors remain generic where possible. | Unchanged. |
| `GET /viewer/fragment.html`, `/viewer/*.js`, `/viewer/*.css` | Return 404 without the asset body unless a valid viewer-asset grant is present; no redirects to a protected URL. | Serve only while the linked server session remains live and the source peer matches. Use `Cache-Control: no-store`. |
| Authenticated `/api/*` and WebRTC signaling | Remain bearer-protected; viewer-asset cookie alone must never authorize them. | Existing bearer and per-route permission checks remain in force. |
| Trust enrollment | Preserve its existing subnet-local restriction and narrow plaintext exception. It is not bundled into the public login page. | Unchanged. |

No wildcard static-file serving is introduced. A new viewer asset must be placed under the protected prefix and added to an explicit allowlist. Shared theme or styling may remain public only when it contains no private state or viewer behavior; viewer-only CSS belongs under `/viewer/`. Requests with unsupported methods and unknown paths remain non-disclosing.

## Owner-chosen public name

Add `publicName` to validated `access-settings.json`, with the generic default `VidVNC host`; **never default or fall back to `os.hostname()`** on an anonymous route. Provide a CLI `public-name [name]` read/set command using the existing access-settings transaction path, so the owner can choose it without editing JSON by hand. The setting is not a native-host control in this change. Trim the value; require 1–80 Unicode code points after trimming; reject C0/C1 controls, Unicode line separators, and bidirectional formatting controls. The CLI and documentation must explicitly call the name public, because anyone who can reach the login page can read it. Render it only as text, not HTML. Existing authenticated `/api/profiles` may continue returning the private `serverName` and other host details after a bearer check; no operating-system hostname, interface list, profile catalog, media state, or connection mode appears in `/api/info`.

The login page must use generic wording that works for all configured connection modes. It cannot choose mode-specific text or disable sign-in based on unauthenticated media status. Report worker availability and mode-specific guidance only after admission, or through generic non-revealing failure text where admission cannot complete.

## Admission to viewer flow

1. The public login script fetches `/api/info`, loads a locally stored approved-client credential if present, and handles key, registration, pending-approval, and approved-client sign-in forms. It does not import viewer modules or construct viewer markup before admission. QR-scanned keys still require the user's explicit Connect action.
2. On successful admission the server returns the existing API bearer in the response body and also sets an independent, cryptographically random 256-bit opaque **viewer-asset grant** cookie. The grant is an in-memory server mapping to that session and its normalized peer IP; it is not the bearer and is never accepted by private APIs. Store no API bearer in URLs, HTML, persistent browser storage, or the asset cookie.
3. The cookie is host-only (no `Domain`), `HttpOnly`, `SameSite=Strict`, `Path=/viewer`, and a browser-session cookie without a persistent expiry. Set `Secure` on HTTPS. The deliberately configured `tls.mode: off` LAN-only HTTP listener omits `Secure` so this existing local mode continues to function; this inherits LAN plaintext risks. Unexpected TLS failure must not fall back to a login or viewer over HTTP.
4. The login script fetches `/viewer/fragment.html` with same-origin credentials and dynamically imports `/viewer/app.js` after admission. It installs the trusted fragment and passes the in-memory bearer to the viewer initializer; the bearer stays in JavaScript memory. The fragment contains no inline script or user-derived HTML, and the existing CSP remains restrictive. Viewer modules and viewer-only CSS import only other protected `/viewer/` assets. The browser may keep one tab/document; the viewer DOM and assets are obtained only after authentication.
5. Each protected asset request checks the opaque grant, current session existence/expiry, and current peer IP **without refreshing the session's idle lifetime**. Missing, invalid, expired, revoked, or wrong-peer grants return the same 404 and no asset bytes. Do not trust forwarded-IP headers. The existing session heartbeat, not asset downloads, keeps the session alive.
6. Session revocation, approval removal, permission change, disconnect, or expiry invalidates the asset grant immediately through the current server-side revoke path. The server clears the browser cookie when responding to a normal disconnect, but correctness does not depend on the browser deleting it. If `/api/reconnect` rotates the session ID, it atomically retires the old grant and issues a new grant for the replacement session; a failed reconnect issues none. Shutdown drops all grants.

All responses carrying the cookie, viewer assets, and private API data use `Cache-Control: no-store`. The public login script must not log or expose the bearer or grant. SameSite, Path, and HttpOnly are defense-in-depth; API authorization still requires an explicit bearer and live-session check, avoiding cookie-based CSRF admission. Origin/Host restrictions remain in place.

## Acceptance tests

- Unauthenticated `/api/info` has exactly one public-name field under default and custom settings; no hostname, connection mode, profile, display, media, audio, control, or private network data leaks through it or the login HTML/JS. The name is text-escaped in the page. Invalid names are rejected; older access-settings files load with the generic default.
- Every viewer-only HTML/JS/CSS asset returns 404 without a grant, with a malformed grant, from a different peer, and immediately after session expiry or revocation. The public bundle cannot import a viewer module or contain the protected viewer markup. Unknown asset paths are not served.
- After each successful key and approved-client sign-in, the viewer fragment/modules load and the existing profile, stream, input, heartbeat, and disconnect flows work. Registration and pending approval remain functional. A successful reconnect replaces the grant; the old grant stops working.
- A valid viewer cookie without the API bearer still gets 401 on protected APIs and cannot create streams, send input, read profiles, or administer anything. A revoked bearer and its viewer grant both stop working immediately; no response cached before revocation is reusable from the browser cache.
- On HTTPS the cookie is `Secure`; in explicit LAN-only HTTP mode it works without `Secure` while off-LAN requests remain rejected. An unavailable HTTPS listener in required mode serves no login/viewer over HTTP. CSP, Host/Origin checks, and the separate loopback diagnostics listener continue to pass their existing tests.
- Browser/UI smoke tests confirm the public screen reveals only the owner-chosen public name and generic admission instructions; authenticated media failures are presented after login rather than advertised anonymously.

## Residual exposure

The public name is deliberately public and is **not proof of host identity**. Users must still verify the host certificate/fingerprint through the established trust process; an attacker may imitate a chosen name. The automatically generated TLS certificate can separately expose the OS hostname and interface IPs through its subject alternative names; this web-page change does not remove that certificate metadata. The public admission and subnet-local trust endpoints remain reachable under their existing rules, and the unresolved Internet/WebRTC deployment findings remain open. Document these facts in the exposure review and changelog when implementing; do not mark remote access broadly secure merely because the page is split.
