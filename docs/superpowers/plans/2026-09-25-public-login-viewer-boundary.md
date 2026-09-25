# Public Login and Protected Viewer Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an anonymous visitor see only an owner-chosen public name and login code; require a live session to fetch viewer HTML, JavaScript, and viewer-only CSS.

**Architecture:** Keep the present bearer-authenticated APIs. Add an independent, short-lived-in-effect opaque cookie for GET-only viewer assets, linked in memory to the active session and socket peer. Split the browser bootstrap so the public module performs admission, then fetches a protected fragment and imports the viewer module.

**Tech Stack:** Node.js 20.6+, ESM, built-in `node:test`, browser JavaScript/CSS, Playwright-based project smoke fixtures; no new dependency.

**Spec:** [public-login-viewer-boundary-design.md](../specs/2026-09-25-public-login-viewer-boundary-design.md)

## Global Constraints

- Default public name is exactly `VidVNC host`; trim it, require 1–80 Unicode code points, and reject C0/C1, line separators, and bidirectional formatting controls. Never expose `os.hostname()` anonymously.
- `GET /api/info` returns exactly `{ "publicName": "…" }`; the existing authenticated `/api/profiles` remains bearer-only and may retain private `serverName`.
- A 256-bit opaque viewer cookie is host-only, `HttpOnly`, `SameSite=Strict`, `Path=/viewer`; it is `Secure` on HTTPS and intentionally not `Secure` in explicit LAN-only TLS-off mode. It is a browser-session cookie, not an API bearer.
- Do not use cookies to authorize private APIs or WebRTC signaling. Do not place the bearer in URLs, HTML, persistent storage, or cookie values.
- Protected asset checks use the socket peer, not forwarded headers, and never refresh the session idle timer. Revocation/expiry/reconnect invalidate old grants before protected bytes can be sent.
- Keep current LAN-only HTTP binding/peer checks, required-HTTPS failure behavior, trust enrollment scope, origin/Host checks, CSP, and separate loopback diagnostics listener.
- Work on the existing main checkout as requested; preserve the already modified security-review document and integrate it carefully rather than replacing its edits.

## Review Focus

1. Duplicate, malformed, or oversized viewer cookie headers must deny with the same 404 as a missing cookie; Task 2 tests this.
2. An IPv4-mapped IPv6 peer representation of the same client must match, but a different peer and `X-Forwarded-For` must not; Tasks 2 and 3 test this.
3. Revocation after an asset read starts but before response completion must yield no protected bytes; Task 3 tests this with an injected asset reader.
4. A session-ID rotation during reconnect must invalidate the old grant and issue a working new one, while a failed reconnect issues none; Task 3 tests this.
5. An owner name with astral Unicode, controls, bidirectional formatting, or only whitespace must be handled exactly as specified and rendered as text; Tasks 1 and 4 test this.

## File Structure

- `apps/server/src/access-settings.mjs`, `apps/server/src/cli/commands/settings.mjs`: validated public name and owner CLI command.
- `apps/server/src/session-store.mjs`: non-touching session lookup that still expires and revokes stale sessions.
- `apps/server/src/viewer-asset-grants.mjs` (new): cookie parsing/formatting and bounded session-to-grant mapping; no HTTP routing.
- `apps/server/src/http-app.mjs`: minimal public info, fixed public/protected asset maps, grant issuance/rotation/revocation, HTTP checks.
- `apps/web-client/src/app.js`: public admission only; owns no viewer behavior.
- `apps/web-client/src/viewer/app.js` and `apps/web-client/src/viewer/fragment.html` (new): viewer behavior and markup loaded after admission. Existing physical helper modules can stay at their current paths but must be served only at explicit `/viewer/` URLs; diagnostics continues loading its own copies from the private listener.
- `apps/web-client/src/viewer/style.css` (new): viewer-only rules extracted from `style.css` and `shell.css`; shared login/trust styling remains public.
- Server and browser tests named below; `README.md`, `CHANGELOG.md`, and the current Internet-exposure review document describe the changed surface and residual risk.

---

### Task 1: Owner Public Name and Minimal Anonymous Info

**Files:**
- Modify: `apps/server/src/access-settings.mjs`, `apps/server/src/cli/commands/settings.mjs`, `apps/server/src/http-app.mjs`
- Test: `apps/server/tests/access-settings.test.mjs`, `apps/server/tests/cli-commands.test.mjs`, `apps/server/tests/cli-parity.test.mjs`, `apps/server/tests/http-security.test.mjs`, `apps/server/tests/client-settings.test.mjs`

**Interfaces:** Produces `access.snapshot().publicName: string`, `public-name [name]`, and the one-field `GET /api/info` body. Later browser work consumes `publicName`.

- [ ] **Step 1: Write failing tests.** Extend the existing access-settings deep-equals with `publicName: 'VidVNC host'`; add a saved custom name with trim and astral characters, and rejection of empty/81-code-point/control/bidi names. Add `public-name` to the CLI parity script and a read/set/invalid CLI test. Replace old `info.display` and `info.control` assertions with an exact shape assertion:

```js
assert.deepEqual(await (await fetch(url + '/api/info')).json(), {
  publicName: 'VidVNC host',
});
assert.equal((await run('public-name')).text, 'Public login name: VidVNC host');
assert.equal((await run('public-name "Office PC" --json')).data.publicName, 'Office PC');
await assert.rejects(run('public-name "   "'), /public name/i);
```

- [ ] **Step 2: Confirm red.** Run `node --test apps/server/tests/access-settings.test.mjs apps/server/tests/cli-commands.test.mjs apps/server/tests/cli-parity.test.mjs apps/server/tests/http-security.test.mjs apps/server/tests/client-settings.test.mjs`; require failures for absent name/old info shape, not infrastructure errors.
- [ ] **Step 3: Implement the smallest change.** Normalize in `validate` before returning `next`; add the command to `securitySettingsCommands`; use `access?.snapshot().publicName ?? 'VidVNC host'` in the public info branch, leaving `serverName` exclusively on the authenticated catalog:

```js
if (typeof next.publicName !== 'string') throw new Error('Invalid public name');
const name = next.publicName.trim();
if (
  [...name].length < 1 ||
  [...name].length > 80 ||
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(name)
) throw new Error('Invalid public name');
next.publicName = name;
// In the GET /api/info branch:
return send(response, 200, { publicName: access?.snapshot().publicName ?? 'VidVNC host' });
```

- [ ] **Step 4: Confirm green.** Re-run the five targeted test files. Update any exact access snapshot fixtures in `cli-commands.test.mjs` and `access-settings.test.mjs` to include the new default.
- [ ] **Step 5: Commit this independently testable configuration/API change.** Stage only Task 1 files; commit `feat: limit public info to owner chosen name`.

### Task 2: Non-Touching Session Check and Viewer Grant Module

**Files:**
- Modify: `apps/server/src/session-store.mjs`
- Create: `apps/server/src/viewer-asset-grants.mjs`
- Test: `apps/server/tests/session-lifecycle.test.mjs`, `apps/server/tests/viewer-asset-grants.test.mjs` (new)

**Interfaces:** `SessionStore.peek(sessionId): session|null` checks expiry and may revoke but does not update `lastSeenAt`. `ViewerAssetGrants.issue(sessionId, peer): string`, `allows(cookieHeader, peer, sessionStore): boolean`, `revoke(sessionId): void`, `clear(): void`; `viewerCookie(value, secure): string` and `clearViewerCookie(secure): string`.

- [ ] **Step 1: Write failing unit tests.** Use a fake clock and `SessionStore.connectApproved`; assert `peek` does not keep a session alive. Test 43-character base64url grants, one grant per session, missing/duplicate/malformed/oversized cookies, IPv4-mapped peer equivalence, wrong peer, old grant after replacement, expiry, revoke, clear, and both cookie attribute variants:

```js
let now = 0;
const sessions = new SessionStore({ clock: () => now, sessionTtlMs: 20_000 });
const id = sessions.connectApproved({ id: 'client-1', generation: 0 }, '127.0.0.1').sessionId;
const grants = new ViewerAssetGrants();
const value = grants.issue(id, '127.0.0.1');
now = 19_000;
assert.equal(grants.allows('vidvnc-viewer=' + value, '::ffff:127.0.0.1', sessions), true);
now = 20_000;
assert.equal(grants.allows('vidvnc-viewer=' + value, '127.0.0.1', sessions), false);
```

- [ ] **Step 2: Confirm red.** Run `node --test apps/server/tests/session-lifecycle.test.mjs apps/server/tests/viewer-asset-grants.test.mjs`; expect missing method/module failures.
- [ ] **Step 3: Implement module and lookup.** Make `get` call `peek` then touch; `peek` performs the existing expiry/disconnect check without assignment to `lastSeenAt`. Use `randomBytes(32).toString('base64url')`, a token map plus reverse session map, an exact single-cookie parser with a reasonable 4 KiB header limit, and normalized socket IPs. `allows` must call `peek` and compare the live session's source IP too:

```js
peek(sessionId) {
  const session = this._sessions.get(sessionId);
  if (!session) return null;
  if (this.clock() - session.lastSeenAt >= this.sessionTtlMs) {
    this.disconnect(sessionId);
    return null;
  }
  return { ...session };
}
// viewer-asset-grants.mjs:
export const viewerCookie = (value, secure) =>
  'vidvnc-viewer=' + value + '; Path=/viewer; HttpOnly; SameSite=Strict' +
  (secure ? '; Secure' : '');
```

- [ ] **Step 4: Confirm green.** Re-run both targeted test files, including source mismatch and clock-boundary cases.
- [ ] **Step 5: Commit.** Stage only Task 2 files; commit `feat: add revocable viewer asset grants`.

### Task 3: Add Protected Viewer Routes and Wire Grant Lifecycle

**Files:**
- Modify: `apps/server/src/http-app.mjs`
- Test: `apps/server/tests/http-security.test.mjs`, `apps/server/tests/client-settings.test.mjs`, `apps/server/tests/tls/anchor-endpoint.test.mjs`, `apps/server/tests/tls/listener.test.mjs`, `apps/server/tests/tls/trust-page.test.mjs`

**Interfaces:** Consumes Task 2 grant module and `SessionStore.peek`. Adds a fixed `VIEWER_ASSETS` mapping from protected URL to physical file. Accepts optional `assetReader = readFile` for a race regression. Admission and successful reconnect set the viewer cookie; disconnect clears it. Keep old root viewer-helper routes temporarily so the existing browser still works; Task 4 removes them atomically with the browser cutover.

- [ ] **Step 1: Write failing HTTP tests.** Add positive/negative GETs for the new protected URL of an already-present helper module, using the `Set-Cookie` from key admission. Check no-cookie, duplicate-cookie, cookie-only API POST, `X-Forwarded-For` forgery, revoke, expiry, HTTPS `Secure`, explicit LAN HTTP without `Secure`, required-HTTPS `503`, and successful/failed reconnect. In a delayed injected `assetReader`, revoke after the read starts and assert no module bytes are returned:

```js
const admitted = await post(url + '/api/key-start', { key: server.sessionStore.password });
const cookie = admitted.headers.get('set-cookie').split(';', 1)[0];
assert.equal((await fetch(url + '/viewer/receiver-stats.js')).status, 404);
assert.equal((await fetch(url + '/viewer/receiver-stats.js', { headers: { cookie } })).status, 200);
assert.equal((await post(url + '/api/profiles', {}, null, { cookie })).status, 401);
server.sessionStore.disconnect((await admitted.json()).sessionId);
assert.equal((await fetch(url + '/viewer/receiver-stats.js', { headers: { cookie } })).status, 404);
```

- [ ] **Step 2: Confirm red.** Run `node --test apps/server/tests/http-security.test.mjs apps/server/tests/client-settings.test.mjs apps/server/tests/tls/anchor-endpoint.test.mjs apps/server/tests/tls/listener.test.mjs apps/server/tests/tls/trust-page.test.mjs`. The new protected helper URL must fail before routing is added, then return actual module bytes with a grant.
- [ ] **Step 3: Implement explicit routes and lifecycle.** Public static allowlist temporarily retains its old entries, including root viewer helpers, so the browser remains usable until Task 4. Map the new `/viewer/` URLs to fixed package files. Gate before reading and recheck after `assetReader` resolves, before writing headers. Give all static responses `no-store`. Set a cookie only for successful admission and successful reconnect; clear it on disconnect. In the existing `onRevoke` wrapper call `grants.revoke(id)` before asynchronous teardown, and clear grants on server close:

```js
const VIEWER_ASSETS = new Map([
  ['/viewer/fragment.html', 'viewer/fragment.html'],
  ['/viewer/app.js', 'viewer/app.js'],
  ['/viewer/style.css', 'viewer/style.css'],
  ['/viewer/receiver-stats.js', 'receiver-stats.js'],
  ['/viewer/stream-subscriptions.js', 'stream-subscriptions.js'],
  ['/viewer/codec-preferences.js', 'codec-preferences.js'],
  ['/viewer/profile-labels.js', 'profile-labels.js'],
]);
// In the protected GET branch:
if (!grants.allows(request.headers.cookie, request.socket.remoteAddress, sessionStore))
  return send(response, 404, { error: 'Not found' });
const bytes = await assetReader(new URL(import.meta.resolve('@vidvnc/web-client/' + file)));
if (!grants.allows(request.headers.cookie, request.socket.remoteAddress, sessionStore))
  return send(response, 404, { error: 'Not found' });
```

- [ ] **Step 4: Confirm green.** Re-run targeted server tests now, using the protected helper URL. Verify the existing trust-page allowlist remains exact and diagnostics still returns 404 on the main listener.
- [ ] **Step 5: Commit the independently testable route infrastructure.** Stage Task 3 files only; commit `feat: add revocable viewer asset route`.

### Task 4: Separate Public Admission UI from Protected Viewer UI

**Files:**
- Modify: `apps/web-client/src/index.html`, `apps/web-client/src/app.js`, `apps/web-client/src/style.css`, `apps/web-client/src/shell.css`, `apps/server/src/http-app.mjs`
- Create: `apps/web-client/src/viewer/fragment.html`, `apps/web-client/src/viewer/app.js`, `apps/web-client/src/viewer/style.css`
- Test: `apps/web-client/tests/password-entry.test.mjs`, `apps/web-client/tests/approved-client.test.mjs`, `apps/web-client/tests/web-browser-check.mjs`, `apps/web-client/tests/stream-browser-check.mjs`, `apps/web-client/tests/toolbar-browser-check.mjs`, `apps/server/tests/http-security.test.mjs`, `apps/server/tests/tls/anchor-endpoint.test.mjs`

**Interfaces:** `app.js` calls `createViewer({ onExit })` exported by protected `viewer/app.js`; the returned controller has `start(result): Promise<void>` and `disconnect(message): Promise<void>`. It owns bearer, WebRTC, heartbeat, input, media, and reconnect state. An explicit `disconnect` does not call `onExit` again; unexpected viewer termination does. The public script owns only admission form state and the active controller reference.

- [ ] **Step 1: Write failing boundary and browser tests.** Assert `index.html` has no `#viewer`, video/audio element, stream label, or protected module import; `app.js` has no `/api/profiles`, `/api/offer`, `/api/stream-*`, or input-channel code. Update server public-asset tests so old root viewer helpers return 404 and new viewer fragment/JS/CSS return 404 without a grant and actual bytes with a grant. On the real browser fixture, assert `#viewer` and `#video` do not exist before sign-in, `/viewer/` assets are not requested until a successful admission, the chosen name is inserted with `textContent`, and after sign-in the existing video/control/UI tests still work:

```js
await page.goto(url);
assert.equal(await page.locator('#viewer').count(), 0);
assert.equal(await page.locator('#video').count(), 0);
await page.waitForFunction(() => document.getElementById('serverName')?.textContent === 'VidVNC host');
await page.locator('#password').fill(sessionPassword);
await page.locator('#connect').click();
await page.waitForFunction(() => document.getElementById('video')?.videoWidth > 0);
```

- [ ] **Step 2: Confirm red.** Run `node --test apps/web-client/tests/password-entry.test.mjs apps/web-client/tests/approved-client.test.mjs`; run the project's browser-check entry when its Playwright fixture is available. Record any pre-existing browser dependency failure separately from a boundary assertion failure.
- [ ] **Step 3: Move markup and styling.** Leave only login forms, shared header/appearance controls, empty header/main mounts, and status in `index.html`. Place existing `#sessionIdentity`, `#disconnect`, and complete `#viewer` subtree into `viewer/fragment.html`. Move selectors from `style.css` for `.stage`, `video`, `.immersive-toolbar`, `.toolbar`, and viewer-only audio into `viewer/style.css`; move viewer-specific selectors from `shell.css` beginning at `.display-picker` through `.connection-details`, viewer responsive rules, and the `main:has(#viewer:not([hidden]))` section. Keep `[hidden]`, login, theme, and trust-shared styles public. Load protected CSS only after admission:

```js
async function loadViewerStyle() {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/viewer/style.css';
  document.head.append(link);
  await new Promise((resolve, reject) => {
    link.onload = resolve;
    link.onerror = reject;
  });
}
```

- [ ] **Step 4: Split JavaScript and switch the server allowlist atomically.** Keep `showAuthentication`, key normalization, approved-client registration/status/sign-in, and `/api/info` handling in public `app.js`; populate the login name from `info.publicName` via `textContent`, not `info.serverName`. Replace mode-specific prelogin copy with generic key/setup guidance, and remove the anonymous media-readiness check that currently disables sign-in. Transfer the existing viewer rendering/media/input/heartbeat/reconnect functions and their listeners into `viewer/app.js`, importing helpers only by relative URLs that resolve under `/viewer/`. On successful admission, fetch static fragment, insert its header/main nodes into the empty mounts, load CSS, dynamically import the protected module, and pass the session result; if any of those steps fails, disconnect the newly issued bearer and return to login. The fragment contains no script or user-derived HTML. On exit call the controller's disconnect before restoring the login forms. Keep the bearer in the protected module's memory; on `pagehide` disconnect it. Use one controller per admitted session so reconnect token rotation stays internal. Remove old root viewer-helper URLs from `http-app.mjs` only in this step, keeping diagnostics' separate private asset routes intact:

```js
async function enterViewer(result) {
  const response = await fetch('/viewer/fragment.html', {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Viewer is unavailable. Sign in again.');
  const fragment = document.createElement('template');
  fragment.innerHTML = await response.text();
  document.getElementById('viewerHeaderMount').replaceChildren(
    fragment.content.querySelector('#sessionIdentity'),
    fragment.content.querySelector('#disconnect'),
  );
  document.getElementById('viewerMount').replaceChildren(
    fragment.content.querySelector('#viewer'),
  );
  await loadViewerStyle();
  const { createViewer } = await import('/viewer/app.js');
  viewer = createViewer({ onExit: returnToLogin });
  await viewer.start(result);
}
async function returnToLogin(message) {
  const active = viewer;
  viewer = null;
  await active?.disconnect(message);
  document.getElementById('welcome').hidden = false;
  showPreferredAuthentication();
  document.getElementById('status').textContent = message;
}
async function retireAdmission(sessionId) {
  await fetch('/api/disconnect', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + sessionId },
    body: '{}',
    keepalive: true,
  }).catch(() => {});
}
```

- [ ] **Step 5: Confirm green and commit.** Run the web-client unit tests and browser fixtures, including approved-client sign-in, QR key gesture, legacy and subscription WebRTC, controls, reconnect, disconnect/re-login, narrow mobile layout, and CSP/no-inline-script behavior. Stage only Task 4 files; commit `feat: load viewer UI only after admission`.

### Task 5: Cross-Surface Verification and Security Documentation

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `docs/security/internet-exposure-review-2026-09-24.md`
- Test/check: full portable suite, formatting, host test, runtime startup check, browser fixtures, manual route probe

**Interfaces:** No new code interface. The review states precisely which anonymous routes/assets remain, the certificate-SAN identity leak, and why F6/remote deployment is still open.

- [ ] **Step 1: Re-read the live route table and existing uncommitted review diff.** Preserve the user's review edits and replace only now-stale statements that anonymous clients can fetch viewer HTML/JS or host details from `/api/info`. Add concise exposure-map wording: public HTTPS can show chosen name/login and accept admission attempts; viewer assets and private APIs require a live session/bearer respectively. Keep same-host proxy, TLS trust, F5, F6, F7, and certificate-SAN residuals explicit.
- [ ] **Step 2: Document owner setting and behavior.** Add `public-name "Office PC"` and the default/public-warning copy to `README.md`; add a concise `[Unreleased]` entry to `CHANGELOG.md`. In the security review, distinguish page-data reduction from remote-readiness:

```text
Anonymous HTTPS: login page, owner-chosen public name, and admission attempts.
After admission: session-gated viewer assets; bearer-gated profiles, signaling, and streams.
Still unresolved: remote WebRTC/firewall policy, same-host proxy laundering, certificate identity, and Internet-edge protection.
```

- [ ] **Step 3: Run full checks.** Run `npm test`, `npm run format:check`, `npm run test:host`, `node apps/server/tests/runtime-start-check.mjs`, and `dotnet build apps/windows-host/VidVnc.Host.csproj --no-restore`. Run the project browser fixtures per their existing test harness. Probe `GET /`, `GET /api/info`, unauthenticated/protected viewer assets, cookie-only API, revocation, LAN HTTP, and required-HTTPS failure on live local test listeners.
- [ ] **Step 4: Review the final diff and commit documentation.** Run `git diff --check`; verify no private route or host detail survived in the public HTML/JS and no protected asset path is in the public static allowlist. Stage only the documentation files, including the previously dirty review after checking its diff; commit `docs: update Internet exposure after viewer boundary`.

## Final Acceptance

- [ ] Every spec acceptance bullet has a passing automated test or a clearly named manual check; failures and untested cases are reported, not inferred.
- [ ] A fresh source review confirms public login code only, one-field `/api/info`, protected viewer assets, bearer-only private API, and immediate server-side grant invalidation.
- [ ] The remaining remote-access limitations are explicit in the review and handoff; no claim that the service is Internet-ready.
