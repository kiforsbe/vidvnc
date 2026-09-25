# LAN-only HTTP and fail-closed TLS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix F1's production LAN-scope wiring and close F3's public HTTP, TLS-fallback, request-target, and remote trust-enrollment paths without removing deliberate LAN-only TLS-off use.

**Architecture:** One refreshed local scope supplies both peer admission and eligible LAN bind addresses. A small manager owns one bounded HTTP listener per allowed host address and shares one request handler; the handler enforces TLS state and trust locality independently. The Windows host and CLI show a viewer address only when HTTPS is live or HTTP was deliberately enabled.

**Tech Stack:** Node.js ESM and `node:test`, Windows PowerShell LAN detection, WinUI/.NET host, no new dependencies.

**Spec:** [LAN-only HTTP and fail-closed TLS design](../specs/2026-09-24-lan-http-and-fail-closed-tls-design.md)

## Global Constraints

- Work on the existing `main` checkout; the owner previously declined an isolated worktree. Preserve the pre-existing uncommitted README/changelog/security-review edits and stage only each task's own files.
- Default ports remain HTTP 4382 and HTTPS 4383. Diagnostics stays on a separate OS-assigned `127.0.0.1` port and never appears on the main listeners.
- Eligible nonloopback HTTP binds come only from up, physical Ethernet/Wi-Fi adapters with Windows Private profile and RFC 1918 IPv4 or ULA IPv6 addresses. Loopback is always permitted; detection failure means loopback-only. `localSessionNetworks` narrows peers, not bind-address eligibility.
- `VIDVNC_HOST` still controls HTTPS. For HTTP it may narrow eligible LAN IPs but never widen them; loopback remains bound. Never use client forwarding headers to establish locality or TLS.
- A valid, explicit `tls.mode: off` retains the full LAN-only HTTP viewer. Auto/provided, invalid settings, or HTTPS listener failure must not admit the viewer, authentication, bearer APIs, or signaling over HTTP.
- Trust page/assets/status/anchor are local-peer only on **both** schemes. No new remote mode, public certificate requirement, TURN service, or approved-client identity change. F6 remains open.
- Use test-first cycles, `apply_patch` for code/doc edits, and explicit-path commits. Do not commit or overwrite the user's existing dirty documentation unless the task later updates those files deliberately.

## File map

| Unit                                                                                                           | Ownership                                                                                |
| -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/server/src/local-session-scope.mjs`                                                                      | Refreshed peer CIDRs and eligible host bind addresses.                                   |
| `apps/server/src/lan-http-listeners.mjs` (new)                                                                 | Per-address HTTP binding, peer rejection, reconciliation, and shutdown.                  |
| `apps/server/src/http-request-target.mjs` (new)                                                                | Origin/absolute-form parsing and authority validation.                                   |
| `apps/server/src/http-app.mjs`                                                                                 | One shared router: HTTP/TLS admission, trust locality, session-password check.           |
| `apps/server/src/server-http-stack.mjs` (new)                                                                  | Testable production assembly of router, scope, and LAN listener manager.                 |
| `apps/server/src/main.mjs`                                                                                     | Starts/reconciles/stops the stack and emits actual bound/viewer addresses.               |
| `apps/server/src/tls/{addresses,load-settings,listener,desktop-status}.mjs`, `apps/server/src/cli/console.mjs` | Truthful address, CLI, and TLS-failure/status copy; no change to certificate strategies. |
| `apps/windows-host/{HostWindow.cs,HostWindow.Tls.cs,HostWindow.Layout.cs}`                                     | Pending/unavailable versus active/off viewer and trust address UI.                       |
| Matching `apps/server/tests/**`, `apps/windows-host/tests/Navigation/**`                                       | Contract, raw-socket, startup, and UI regressions.                                       |
| `README.md`, `docs/ARCHITECTURE.md`, `docs/security/*`, `CHANGELOG.md`                                         | Final current-state documentation.                                                       |

## Review Focus

1. IPv4-mapped IPv6 peers and IPv6 ULA host strings must be normalized consistently; an off-link peer must not slip through or cause the UI to show an unusable bare IPv6 URL. Task 1/4 tests pin both.
2. A Private-to-Public adapter change during a keep-alive HTTP session must deny the next request and remove that bound listener; reconnect must not revive an old password path. Task 3/4 tests pin it.
3. `VIDVNC_HOST` set to a public IP, hostname, or loopback must never make HTTP bind publicly or advertise a nonbound LAN URL. Task 4/5 tests pin it.
4. An invalid TLS file is represented as `mode: off, invalid: true`; it must fail closed, never inherit deliberate-off behavior or display “HTTP pairing available.” Task 3/5/6 tests pin it.
5. Absolute-form targets with mismatched Host, scheme, port, or query must not reach `/api/key-start` on HTTP; matching targets preserve path/query in a safe HTTPS redirect. Task 2/3 raw-request tests pin it.

---

### Task 1: Expose eligible host bind addresses from the refreshed local scope

**Files:** Modify `apps/server/src/local-session-scope.mjs`; test `apps/server/tests/local-session-scope.test.mjs`.

**Interfaces:** `createLocalSessionScope(options)` keeps `allows(peer, listenerScope)` and adds read-only `bindAddresses: string[]` (fresh copy, adapter IPs only; manager adds loopback). `createLocalSessionScopeController(...).refresh()` updates both views in one `scope.update()` call. Task 4 consumes `bindAddresses`.

- [ ] **Step 1: Write failing scope tests.** Extend the existing file with real `createLocalSessionScope` assertions:

```js
test('bind addresses follow eligible adapters, not a narrower peer CIDR', () => {
  const scope = createLocalSessionScope({
    adapters: [privateWifi, { ...privateWifi, address: '10.2.3.4', profile: 'Public' }],
    override: ['192.168.10.32/27'],
  });
  assert.deepEqual(scope.bindAddresses, ['192.168.10.12']);
  assert.equal(scope.allows('192.168.10.44', 'local'), true);
  assert.equal(scope.allows('192.168.10.90', 'local'), false);
  scope.update({ error: new Error('adapter query failed') });
  assert.deepEqual(scope.bindAddresses, []);
});
```

Add an eligible IPv6 ULA row and assert its unbracketed bind address appears once; test that mutating the returned array does not mutate the scope.

- [ ] **Step 2: Run red.** `node --test apps/server/tests/local-session-scope.test.mjs`; expect the new `bindAddresses` equality to fail because it is currently absent.
- [ ] **Step 3: Implement the minimal scope extension.** Compute eligible adapter records once per `update()`; keep `allowed` CIDRs and `bindAddresses` separate:

```js
let bindAddresses = [];
const scope = {
  get bindAddresses() {
    return [...bindAddresses];
  },
  // existing reason, update, and allows members
};
// Inside update(), after adapter eligibility is known:
bindAddresses = [...new Set(eligible.map((row) => row.address))];
allowed = requested ?? eligible.map((row) => row.network);
// On detection failure: bindAddresses = []; allowed = [];
```

Keep the current off-link override behavior: it empties `allowed`, not the eligible adapter bind list. Do not broaden `allows()`.

- [ ] **Step 4: Run green.** `node --test apps/server/tests/local-session-scope.test.mjs`; expect 0 failures. Run `npm run format:check`.
- [ ] **Step 5: Commit only these files.** `git add apps/server/src/local-session-scope.mjs apps/server/tests/local-session-scope.test.mjs`, then `git commit -m "feat: expose eligible LAN bind addresses"`.

### Task 2: Parse HTTP request targets without authority confusion

**Files:** Create `apps/server/src/http-request-target.mjs` and `apps/server/tests/http-request-target.test.mjs`; modify `apps/server/src/http-app.mjs` and `apps/server/tests/tls/listener.test.mjs`.

**Interfaces:** `parseRequestTarget(raw: string, scheme: 'http'|'https', hostHeader: string, localPort: number) -> { route: string, pathAndQuery: string, originForm: boolean }`; throws an error with `status: 400` for malformed/unsupported targets or `status: 421` for authority/scheme mismatch. Task 3 calls it before routing, after the existing local-host allowlist. The accepted `Host` port must match the socket's local port (or use the scheme's default port when omitted); an arbitrary Host header is not enough to establish authority.

- [ ] **Step 1: Write failing raw-target tests against the existing router.** Replace the old “non-origin-form is not redirected” expectation with a matching absolute-form POST to `/api/key-start?x=1` that must return `307` to the HTTPS path/query and must not create a session. Add cases whose target URL disagrees with `Host`, plaintext scheme, or port; each must return `400` or `421`, never `201`. In the parser unit test, pin `*`, CONNECT authority-form, fragment, missing Host, and origin-form `//` behavior.

```js
const response = await rawExchange(
  plaintext.port,
  `POST http://127.0.0.1:${plaintext.port}/api/key-start?x=1 HTTP/1.1\r\n` +
    `Host: 127.0.0.1:${plaintext.port}\r\nContent-Type: application/json\r\n` +
    'Content-Length: 2\r\nConnection: close\r\n\r\n{}',
);
assert.equal(response.status, 307);
assert.equal(response.headers.location, 'https://127.0.0.1:8443/api/key-start?x=1');
```

- [ ] **Step 2: Run red.** `node --test apps/server/tests/tls/listener.test.mjs`; expect the new absolute-form redirect assertion to fail because the request currently falls through to key admission.
- [ ] **Step 3: Add the parser and wire it into the router.** For origin-form, parse by prepending the validated socket scheme and `Host` so `//x` remains a path, not a new authority. Reject malformed `Host` and a Host port different from the socket's local port. For absolute-form, require `target.protocol === scheme + ':'`, normalized `target.host === expected.host`, and no credentials/fragment; return only `pathname + search` for redirects. For `*`, CONNECT authority-form, or malformed syntax, throw a status-tagged error. The router's existing catch block must map that status without exposing the submitted target. Keep its local-host allowlist before using the parsed host for a redirect.

```js
if (typeof hostHeader !== 'string' || !hostHeader)
  throw Object.assign(new Error('Host is required'), { status: 400 });
let expected, target;
const originForm = raw.startsWith('/');
if (!originForm && !/^https?:\/\//i.test(raw))
  throw Object.assign(new Error('Unsupported request target'), { status: 400 });
try {
  expected = new URL(`${scheme}://${hostHeader}`);
  target = new URL(originForm ? `${scheme}://${hostHeader}${raw}` : raw);
} catch {
  throw Object.assign(new Error('Invalid request target'), { status: 400 });
}
if (
  target.hash ||
  Number(expected.port || (scheme === 'https' ? 443 : 80)) !== localPort ||
  (!originForm &&
    (target.protocol !== `${scheme}:` ||
      target.host !== expected.host ||
      target.username ||
      target.password ||
      target.hash))
)
  throw Object.assign(new Error('Request target does not match this listener'), { status: 421 });
return { route: target.pathname, pathAndQuery: target.pathname + target.search, originForm };
```

- [ ] **Step 4: Run green.** `node --test apps/server/tests/tls/listener.test.mjs apps/server/tests/http-request-target.test.mjs`; expect 0 failures and verify malformed targets are not routed.
- [ ] **Step 5: Commit explicit paths.** `git add apps/server/src/http-request-target.mjs apps/server/src/http-app.mjs apps/server/tests/http-request-target.test.mjs apps/server/tests/tls/listener.test.mjs`, then `git commit -m "fix: validate absolute HTTP request targets"`.

### Task 3: Make the shared router fail closed and keep trust enrollment local

**Files:** Modify `apps/server/src/http-app.mjs`; test `apps/server/tests/tls/listener.test.mjs`, `apps/server/tests/tls/trust-page.test.mjs`, `apps/server/tests/tls/anchor-endpoint.test.mjs`, `apps/server/tests/http-security.test.mjs`.

**Interfaces:** `createHttpApp({ localSessionScope, tls, plaintextMode })` gains `plaintextMode: 'lan-http'|'https-required'`; its default is `'https-required'` when `tls` is supplied and `'lan-http'` only for isolated callers with no TLS listener. Main passes the value explicitly in Task 5. The same local scope governs standing passwords, all HTTP requests, and trust routes on either scheme.

- [ ] **Step 1: Write failing endpoint tests.** A fake inactive TLS status with `plaintextMode: 'https-required'` must return no-store `503` for `GET /`, `GET /api/info`, `POST /api/key-start`, approved sign-in, bearer heartbeat, and stream offer. `plaintextMode: 'lan-http'` must still admit a loopback key. An injected scope whose `allows()` returns false must refuse local-socket HTTP, plus `/trust`, trust assets, `/api/trust/status`, and `/api/trust/anchor` on HTTPS. Update old fallback tests that assert full plaintext service.

```js
const app = createHttpApp({
  tls: { status: () => ({ active: false, port: null }) },
  plaintextMode: 'https-required',
});
// Bind app on 127.0.0.1 with the existing test helper.
assert.equal((await fetch(base + '/api/info')).status, 503);
assert.equal((await post(base + '/api/key-start', { key: app.sessionStore.password })).status, 503);
```

- [ ] **Step 2: Run red.** `node --test apps/server/tests/tls/listener.test.mjs apps/server/tests/http-security.test.mjs`; expect the new inactive-TLS requests to return the old `200`/`201`, not `503`.
- [ ] **Step 3: Implement the minimal guards before route dispatch.** Derive `scheme` from `request.socket.encrypted`; parse the target from Task 2; check HTTP peer locality on every request and trust-route locality on both schemes. For `https-required` HTTP non-trust paths, redirect only when `tls.status().active`; otherwise send no-store `503`. Preserve explicit `lan-http` routing. Keep the existing diagnostics `404` ahead of any redirect so main ports never expose it.

```js
const isLocal = localSessionScope.allows(request.socket.remoteAddress, 'local');
if (scheme === 'http' && !isLocal) return send(response, 403, { error: 'Local network only.' });
if (PLAINTEXT_ALLOWED_PATHS.includes(route) && !isLocal)
  return send(response, 403, { error: 'Trust enrollment is local only.' });
if (
  scheme === 'http' &&
  plaintextMode === 'https-required' &&
  !PLAINTEXT_ALLOWED_PATHS.includes(route)
) {
  const live = tls?.status();
  if (!live?.active) return send(response, 503, { error: 'HTTPS is unavailable.' });
  response.writeHead(307, {
    location: `https://${host}:${live.port}${pathAndQuery}`,
    'cache-control': 'no-store',
  });
  return response.end();
}
```

- [ ] **Step 4: Run green.** Run the four touched test files with `node --test`; expect 0 failures. Run `npm test` to catch existing fixtures that supply an inactive fake TLS listener and deliberately expect plaintext.
- [ ] **Step 5: Commit explicit paths.** `git add apps/server/src/http-app.mjs apps/server/tests/http-security.test.mjs apps/server/tests/tls/listener.test.mjs apps/server/tests/tls/trust-page.test.mjs apps/server/tests/tls/anchor-endpoint.test.mjs`, then `git commit -m "fix: fail closed on TLS loss and localize trust routes"`.

### Task 4: Bind and reconcile only eligible LAN HTTP addresses

**Files:** Create `apps/server/src/lan-http-listeners.mjs` and `apps/server/tests/lan-http-listeners.test.mjs`; use `apps/server/src/server-limits.mjs` without changing its limits.

**Interfaces:** `desiredHttpAddresses(scope, hostPreference) -> string[]` always includes `127.0.0.1`, optionally `::1`, and eligible `scope.bindAddresses` filtered by explicit `VIDVNC_HOST`. `createLanHttpListeners({ port, scope, hostPreference, primaryServer, requestListener, createServer?, log? }) -> { start(), reconcile(), close(), addresses() }`; `primaryServer` is the `createHttpApp()` server used for the required IPv4 loopback bind. Other addresses get separate `http.Server`s sharing its handler. `addresses()` contains only bound `{host, port}` rows. Task 5 owns lifecycle calls.

- [ ] **Step 1: Write failing desired-address and lifecycle tests.** For a fake scope with `bindAddresses: ['192.168.10.12', 'fd12::42']`, expect no wildcard/public bind. For `hostPreference: '203.0.113.5'` or a hostname, expect loopback-only and a warning. For a scope update to empty addresses, expect both LAN listeners closed while loopback remains. With an injected peer predicate that flips false, a held keep-alive socket's next request must be refused. Add a real loopback ephemeral-port test for `start()`/`close()` and IPv4-mapped peer handling.

```js
assert.deepEqual(
  desiredHttpAddresses({ bindAddresses: ['192.168.10.12', 'fd12::42'] }, '0.0.0.0'),
  ['127.0.0.1', '::1', '192.168.10.12', 'fd12::42'],
);
assert.deepEqual(desiredHttpAddresses({ bindAddresses: ['192.168.10.12'] }, '203.0.113.5'), [
  '127.0.0.1',
  '::1',
]);
```

- [ ] **Step 2: Run red.** `node --test apps/server/tests/lan-http-listeners.test.mjs`; expect the new API/desired-address assertions to fail before the manager exists.
- [ ] **Step 3: Implement listener management.** Use the app's `primaryServer` for `127.0.0.1` so its existing close event cleans up admission sweeps and the session store; each optional address gets a `node:http` server with `applyServerLimits` and the shared `requestListener`. All receive the connection-level peer check. Make `127.0.0.1` bind mandatory; treat `::1` and LAN bind errors as logged optional failures. Reconcile by closing removed sockets before opening additions; serialize overlapping refreshes. Never substitute `0.0.0.0` after an error.

```js
const server = host === '127.0.0.1' ? primaryServer : createServer(requestListener);
if (server !== primaryServer) applyServerLimits(server);
server.prependListener('connection', (socket) => {
  if (!scope.allows(socket.remoteAddress, 'local')) socket.destroy();
});
await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, () => {
    server.off('error', reject);
    resolve();
  });
});
```

On removal, call `closeAllConnections()` and await `close()`. A request-level scope check from Task 3 remains the authority when a socket predates the latest refresh.

- [ ] **Step 4: Run green.** `node --test apps/server/tests/lan-http-listeners.test.mjs apps/server/tests/local-session-scope.test.mjs`; expect 0 failures. Run `npm run format:check`.
- [ ] **Step 5: Commit explicit paths.** `git add apps/server/src/lan-http-listeners.mjs apps/server/tests/lan-http-listeners.test.mjs`, then `git commit -m "feat: bind plaintext only to eligible LAN addresses"`.

### Task 5: Wire production startup, addresses, and TLS policy together

**Files:** Create `apps/server/src/server-http-stack.mjs` and `apps/server/tests/server-http-stack.test.mjs`; modify `apps/server/src/main.mjs`, `apps/server/src/tls/addresses.mjs`, `apps/server/tests/tls/addresses.test.mjs`, `apps/server/tests/runtime-start-check.mjs`.

**Interfaces:** `createHttpStack({ localSessionScope, port, hostPreference, appOptions, log }) -> { app, http }` builds `createHttpApp({ ...appOptions, localSessionScope })` and Task 4's manager with `primaryServer: app` and its shared `requestListener`. `http.addresses()` is the only source of HTTP URL reporting. Main passes `plaintextMode: 'lan-http'` iff `tlsSettings.mode === 'off' && !tlsSettings.invalid`; otherwise `'https-required'`.

- [ ] **Step 1: Write failing assembly/startup tests.** Use a fake scope whose `allows()` denies loopback: the assembled app must refuse `/api/info`, proving the scope reaches the router. An allowed scope must admit the deliberate-off loopback key. Inject a request whose socket peer is an eligible LAN IP into the assembled handler and expect the standing password to be accepted; inject an off-link peer and expect rejection, while a handler with `listenerScope: 'public'` still refuses the standing password. Assert `connectionAddresses` uses supplied bound HTTP addresses rather than an unrelated public or link-local NIC, and returns no viewer URLs for inactive auto TLS. Extend `runtime-start-check.mjs` to verify no public/wildcard HTTP bind and that invalid settings cannot admit the viewer on HTTP; Task 6 pins owner-visible ready/status semantics. Do not require a physical LAN in this portable startup test.

```js
const stack = createHttpStack({
  localSessionScope: { bindAddresses: [], allows: () => false },
  port: 0,
  hostPreference: '127.0.0.1',
  appOptions: { plaintextMode: 'lan-http' },
});
await new Promise((resolve) => stack.app.listen(0, '127.0.0.1', resolve));
assert.equal((await fetch(`http://127.0.0.1:${stack.app.address().port}/api/info`)).status, 403);
```

- [ ] **Step 2: Run red.** `node --test apps/server/tests/server-http-stack.test.mjs apps/server/tests/tls/addresses.test.mjs`; expect the missing assembly/bound-address contract to fail.
- [ ] **Step 3: Implement the assembly and replace main's single wildcard HTTP listen.** Remove unused `listenerScope`, `localSessionScope`, and `admission` properties from the `StreamRuntime` constructor call. Build `httpStack` once, point the TLS listener's lazy callback at `httpStack.app.requestListener`, start `httpStack.http`, reconcile it after each successful/failed `localSession.refresh()`, and close it in `stop()`. Compute addresses from actual `http.addresses()` and keep HTTPS addresses separate. The owner-visible ready/status/CLI switch is Task 6; Tasks 5 and 6 form one integration boundary and must not be released separately.

```js
const plaintextMode =
  tlsSettings.mode === 'off' && !tlsSettings.invalid ? 'lan-http' : 'https-required';
httpStack = createHttpStack({
  localSessionScope: localSession.scope,
  port,
  hostPreference: process.env.VIDVNC_HOST || '0.0.0.0',
  appOptions: {
    runtime,
    serverName: hostname(),
    sessionStore: store,
    media,
    diagnostics,
    policy,
    inventory,
    profileOrderFile: files.profileOrder,
    approvedClients,
    access,
    display: { name: 'Primary display', width: info.width, height: info.height, refreshHz: 30 },
    tls: tlsListener,
    plaintextMode,
  },
  log: serverLog,
});
await httpStack.http.start();
```

Add `httpConnectionAddresses(httpBindings)` in `tls/addresses.mjs` to format actual bound HTTP rows (including bracketed IPv6), LAN roots first and loopback last. Change `connectionAddresses({ interfaces, plaintextPort, httpBindings, tls, plaintextMode, hostPreference })` to return HTTPS addresses when TLS is active (filtered to the actual HTTPS bind preference if it is not wildcard), the `httpConnectionAddresses` result when `plaintextMode === 'lan-http'`, or `{ lan: [], local: null, urls: [] }` when HTTPS is required but inactive. Test explicit HTTPS loopback bind preference so it does not advertise an unbound LAN HTTPS URL. Task 6 will use `connectionAddresses().urls` as viewer URLs and `httpConnectionAddresses().urls` as separate local trust roots. Closing the loopback listener must trigger `createHttpApp()`'s existing cleanup; leaving its server object unbound would leak its sweep timers.

- [ ] **Step 4: Run green.** Run `node --test` on the two new/touched unit files, then `node apps/server/tests/runtime-start-check.mjs`; expect 0 failures. Run `npm test` before moving to UI work.
- [ ] **Step 5: Commit explicit paths.** Stage only this task's source/test files and `git commit -m "fix: wire LAN scope and fail-closed HTTP startup"`.

### Task 6: Make operator status and host UI truthful during TLS failure

**Files:** Modify `apps/server/src/tls/load-settings.mjs`, `apps/server/src/tls/listener.mjs`, `apps/server/src/tls/desktop-status.mjs`, `apps/server/src/tls/addresses.mjs`, `apps/server/src/main.mjs`, `apps/server/src/cli/console.mjs`, `apps/windows-host/HostWindow.cs`, `apps/windows-host/HostWindow.Tls.cs`, `apps/windows-host/HostWindow.Layout.cs`; test `apps/server/tests/tls/{load-settings,listener,desktop-status,addresses}.test.mjs`, `apps/server/tests/cli-console.test.mjs`, `apps/server/tests/runtime-start-check.mjs`, and `apps/windows-host/tests/Navigation/App.xaml.cs`.

**Interfaces:** The owner-only `ready`/`status.tls` payload distinguishes `viewerReady`, `httpViewerEnabled`, `localHttpUrls` (actual bound roots), and `viewerUrls`; existing `active`, `mode`, and sanitized `reason` remain. Extend `tlsDesktopStatus({ settings, status, report, now, localHttpUrls = [], secureUrls = [] })` and pass current roots on every status tick and in `ready.tls`. `viewerUrls` is `secureUrls` for active HTTPS, `localHttpUrls` for valid deliberate-off HTTP, and `[]` otherwise; `viewerReady` is `viewerUrls.length > 0`. `ready.urls` mirrors `viewerUrls`. The native host never promotes a local trust URL to a viewer URL while HTTPS is pending/failed.

- [ ] **Step 1: Write failing status/UI tests.** Pure `tlsDesktopStatus` cases assert invalid `off` and failed `auto` both have `viewerReady: false` and `viewerUrls: []`, deliberate `off` has `httpViewerEnabled: true` and LAN HTTP viewer roots, and active HTTPS has secure viewer roots. Change old log tests that expect “Serving plaintext only” to require fail-closed wording. Add a CLI `info` assertion that inactive auto TLS says HTTPS unavailable, not an HTTP address. Update the Navigation fixture/assertions so pending auto shows “Waiting for HTTPS,” failed auto shows unavailable with disabled preview/connect controls, active TLS shows HTTPS viewer address, and deliberate off shows LAN HTTP viewer address. The trust QR may still use local HTTP `/trust`, but it must not be labeled a remote-safe bootstrap.

```js
assert.equal(
  tlsDesktopStatus({
    settings: { mode: 'off', invalid: true, port: 4383 },
    status: { active: false, port: null },
    report: { failureReason: 'invalid settings' },
    localHttpUrls: ['http://127.0.0.1:4382'],
  }).viewerReady,
  false,
);
```

- [ ] **Step 2: Run red.** `node --test apps/server/tests/tls/load-settings.test.mjs apps/server/tests/tls/listener.test.mjs apps/server/tests/tls/desktop-status.test.mjs apps/server/tests/tls/addresses.test.mjs`; expect new status/copy assertions to fail. Build/run Navigation per its README to observe the old fallback UI assertion failure.
- [ ] **Step 3: Implement status and copy changes.** Keep raw provisioning errors only in local logs; change false “plaintext only” logging to “HTTPS unavailable; viewer admission on HTTP is disabled.” Derive `viewerUrls`, `viewerReady`, and `httpViewerEnabled` from validated settings plus live TLS status; carry current `localHttpUrls` from Task 5. In `ready`, set `urls` to viewer URLs only (empty while auto/provided TLS is pending) and add `tls: tlsField()` with `localHttpUrls` and `viewerUrls`; do not put a trust URL in `ready.urls`. In the host, safely parse `ready.tls` even when `ready.urls` is empty and select the first advertised local HTTP root for `EnrolmentUrl()`. Have `ApplyTlsAddress` and `ConnectionSecurityNote` branch on active HTTPS, valid deliberate off, or unavailable/pending; disable preview/connect QR in the unavailable state while retaining local trust enrollment and owner controls. Recompute `previewUrl` from the current loopback viewer root after every TLS status transition. In CLI `info`, render “HTTPS pending or unavailable” for an empty viewer list instead of a blank or stale HTTP address.

```js
const httpViewerEnabled = settings?.mode === 'off' && !settings?.invalid;
const viewerUrls =
  !settings?.invalid && status?.active ? secureUrls : httpViewerEnabled ? localHttpUrls : [];
const viewerReady = viewerUrls.length > 0;
return {
  mode,
  active: listening,
  port: status?.port ?? null,
  strategy: report?.strategy ?? null,
  enrolmentStatus: report?.enrolmentStatus ?? null,
  fingerprint: report?.fingerprint ?? null,
  expiry: renewal ? renewal.validTo.toISOString() : null,
  expired: renewal ? renewal.expired : false,
  needsRenewal: renewal ? renewal.needsRenewal : false,
  reason: sanitizedReason({
    mode,
    listening,
    configuredPort,
    failed: Boolean(report?.failureReason),
    invalidSettings: Boolean(settings?.invalid),
  }),
  httpViewerEnabled,
  viewerReady,
  localHttpUrls,
  viewerUrls,
};
```

Add `bool HttpViewerEnabled`, `bool ViewerReady`, and `string? ViewerUrl` to `TlsReport`; parse `viewerUrls[0]` into `ViewerUrl` and `localHttpUrls[0]` into `plaintextAddress` in `UpdateTlsStatus`. The native selection must use the explicit viewer list, not derive an HTTPS URL from the trust address:

```csharp
address.Text = tlsReport?.ViewerUrl ?? (tlsReport?.Mode == "off" && tlsReport.HttpViewerEnabled
    ? plaintextAddress ?? "" : "Waiting for HTTPS");
previewUrl = viewerUrls.FirstOrDefault(url =>
    Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Host == "127.0.0.1");
openPreview.IsEnabled = sharing && previewUrl is not null;
connectDevice.IsEnabled = sharing && tlsReport?.ViewerReady == true;
```

- [ ] **Step 4: Run green.** Repeat the Node TLS and CLI tests, `npm run test:host`, `dotnet build apps/windows-host/VidVnc.Host.csproj --no-restore`, and the Navigation exercise documented at `apps/windows-host/tests/Navigation/README.md`. Expect 0 failures; record any GUI/hardware limitation rather than treating a build as a navigation pass.
- [ ] **Step 5: Commit explicit paths.** Stage only the touched TLS/main/host/tests files and `git commit -m "fix: report TLS failure without HTTP viewer fallback"`.

### Task 7: Update review, operator guidance, and final verification

**Files:** Modify `README.md`, `docs/ARCHITECTURE.md`, `docs/security/internet-exposure.md`, `docs/security/internet-exposure.md`, and `CHANGELOG.md`; adjust older baseline/proposal links only if necessary. Preserve and incorporate their pre-existing uncommitted edits instead of replacing them.

**Interfaces:** No new runtime API. Documentation must state that F1's production wiring and F3 code paths are fixed only to the extent verified, distinguish explicit LAN HTTP from fail-closed HTTPS modes, and keep F6 and Internet-release approval open.

- [ ] **Step 1: Make a current-state checklist before editing docs.** Confirm the Task 1–6 tests and code actually show: no wildcard/public HTTP bind, peer denial, no unexpected full HTTP fallback, absolute-form protection, local-only trust on both schemes, truthful host UI. If any item fails, return to its owning task; do not mark it closed in the review.
- [ ] **Step 2: Edit the named docs and changelog.** Replace the review's F1 “LAN-wiring defect” with its verified closure and F3 “open” with a precise residual statement; leave F6 open. Document the same-host-proxy/NAT source-laundering limitation and out-of-band self-signed fingerprint requirement. Update CLI/host instructions to explain that invalid or failed TLS does **not** expose a usable HTTP viewer.
- [ ] **Step 3: Verify docs and full software.** Run `npx --no-install prettier --check README.md CHANGELOG.md docs/ARCHITECTURE.md docs/security/internet-exposure.md docs/security/internet-exposure.md`; run `git diff --check`; run `npm run format:check`, `npm test`, `npm run test:host`, `node apps/server/tests/runtime-start-check.mjs`, and the host build/navigation checks from Task 6. Inspect `git diff` for unrelated files and ensure no user edits were lost.
- [ ] **Step 4: Commit only the intended final docs.** Stage exact paths after reviewing the pre-existing changes; `git commit -m "docs: record LAN-only HTTP and fail-closed TLS status"`. If any pre-existing change cannot be confidently attributed or incorporated, leave it unstaged and report it rather than sweeping it into the commit.
- [ ] **Step 5: Request a security-focused code review.** Check scope-wiring, listener lifecycle, TLS state transitions, target authority, trust-route reachability, and host UI messaging against the spec. Resolve findings and rerun the relevant full verification before claiming F1/F3 closed.
