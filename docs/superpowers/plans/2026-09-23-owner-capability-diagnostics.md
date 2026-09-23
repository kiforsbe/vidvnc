# Owner-Capability Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close F4's unauthenticated same-host proxy path to live diagnostics while preserving a convenient local owner workflow.

**Architecture:** A small in-memory capability issuer is the sole diagnostics API credential authority. The local owner command channel mints a short-lived bearer token; the Windows host or CLI opens a local URL with the token in a fragment. The page strips the fragment immediately and supplies the token only in an Authorization header; the API still requires its existing socket/Host locality guard.

**Tech Stack:** Node.js 20.6+ ES modules and `node:test`, browser JavaScript, Windows host WinUI/C#.

**Spec:** [Selected Internet-exposure hardening design](../specs/2026-09-23-selected-internet-exposure-hardening-design.md), F4. Read the [source review](../../security/internet-exposure-review-2026-09-23.md) for the original proxy bypass.

## Global Constraints

- `GET /diagnostics` may serve only its nonsensitive shell on loopback; `GET /api/diagnostics` requires both existing loopback/Host checks and a valid owner capability.
- Capabilities are 256 random bits, process-memory only, live for 15 minutes, with at most four outstanding. They are minted only on explicit local owner action, never in startup output or routine logs.
- A capability travels in a URL fragment, is removed with `history.replaceState`, is kept in browser memory, and is sent to the API as `Authorization: Bearer`. Query, cookie, Host, forwarding headers, and page URL are not accepted as API proof.
- The server stores hashes, compares in constant time, sends `cache-control: no-store`, and returns generic `403` with no live data for missing/expired/invalid tokens.
- A stolen live bearer remains useful until expiry; this plan does not claim to make a local proxy safe for remote exposure or resolve F3/F6.

## Review Focus

- A same-host proxy that reaches the local handler as `127.0.0.1` with `Host: localhost` must see no live diagnostics without a capability; Task 2 tests the exact headers and socket.
- A token in `?capability=` or a cookie must not work; Task 2 tests both paths.
- A fifth minted token must evict the oldest, leaving at most four hashed entries; Task 1 tests this with a fake clock.
- An expired token must fail even if the page remains open and auto-refreshes; Tasks 1 and 3 test expiration and recovery copy.
- The fragment must not persist in browser history or be sent in a request/referrer; Task 3 checks the page bootstrap and network call.

## File structure and interfaces

- New `apps/server/src/diagnostics-capabilities.mjs` owns minting, hashing, verification, expiry, and the four-entry bound.
- `apps/server/src/http-app.mjs` owns the existing locality check and the new authorization gate. It receives the issuer as `diagnosticsCapabilities`.
- `apps/server/src/main.mjs` owns the local owner-pipe `diagnostics-capability-create` command and never prints tokens in ordinary output. CLI commands in `apps/server/src/cli/commands.mjs` and `console.mjs` call this local authority.
- New `apps/web-client/src/diagnostics-auth.js` owns testable fragment ingestion and history scrubbing; `apps/web-client/src/diagnostics.js` owns `Authorization` on refresh; `diagnostics.html` owns expired-token guidance. `http-app.mjs` serves the new static asset.
- `apps/windows-host/HostWindow.Layout.cs`, `HostWindow.Clients.cs`, and `HostWindow.cs` own explicit Diagnostics click, correlated owner reply, and launch of the fragment-bearing local URL.

---

### Task 1: Build a bounded, hashed capability issuer

**Files:** Create `apps/server/src/diagnostics-capabilities.mjs`, `apps/server/tests/diagnostics-capabilities.test.mjs`.

**Interfaces:** `new DiagnosticsCapabilities({ clock = Date.now, ttlMs = 900_000, maxOutstanding = 4 })`; `.issue() -> { token: string, expiresAt: number }`; `.allows(token) -> boolean`; `.sweep() -> void`. Only SHA-256 hashes are retained, not the bearer.

- [ ] **Step 1: Write failing clock-controlled tests.** Test 32-byte base64url length, no raw token in serialized object, expiry boundary, oldest eviction on the fifth issuance, wrong token, and repeated authorization until expiry.

```js
let now = 1000;
const caps = new DiagnosticsCapabilities({ clock: () => now });
const issued = Array.from({ length: 5 }, () => caps.issue());
assert.match(issued[0].token, /^[A-Za-z0-9_-]{43}$/);
assert.equal(caps.allows(issued[0].token), false);
assert.equal(caps.allows(issued[4].token), true);
assert.equal(JSON.stringify(caps).includes(issued[4].token), false);
now += 900_000;
assert.equal(caps.allows(issued[4].token), false);
```

- [ ] **Step 2: Run `node --test apps/server/tests/diagnostics-capabilities.test.mjs`.** Expect the import to fail.
- [ ] **Step 3: Implement constant-time hash comparison and bounded storage.** Sweep before issuing/checking; use `randomBytes(32).toString('base64url')`, `createHash('sha256')`, and `timingSafeEqual` against fixed-size hash buffers. Reject malformed bearer lengths generically before hash comparison.

```js
issue() {
  this.sweep();
  while (this.hashes.length >= this.maxOutstanding) this.hashes.shift();
  const token = randomBytes(32).toString('base64url');
  const expiresAt = this.clock() + this.ttlMs;
  this.hashes.push({ digest: createHash('sha256').update(token).digest(), expiresAt });
  return { token, expiresAt };
}
allows(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  this.sweep();
  const digest = createHash('sha256').update(token).digest();
  return this.hashes.some((row) => timingSafeEqual(row.digest, digest));
}
```

- [ ] **Step 4: Run `node --test apps/server/tests/diagnostics-capabilities.test.mjs`; expect zero failures.** Inspect object serialization to ensure no token value appears.
- [ ] **Step 5: Commit.** `git add apps/server/src/diagnostics-capabilities.mjs apps/server/tests/diagnostics-capabilities.test.mjs && git commit -m "feat: issue bounded owner diagnostics capabilities"`.

### Task 2: Gate live diagnostics on locality and capability

**Files:** Modify `apps/server/src/http-app.mjs`; test `apps/server/tests/http-security.test.mjs`.

**Interfaces:** `createHttpApp({ diagnosticsCapabilities })` consumes the Task 1 issuer. Only `GET /api/diagnostics` requires `Authorization: Bearer <token>` in addition to the existing loopback/Host rule; `GET /diagnostics` remains a local nonsensitive shell.

- [ ] **Step 1: Write failing HTTP tests using the real bound loopback socket.** Cover missing token, wrong token, query-only token, cookie-only token, valid token, expiry, and `Host` mismatch. Use a fake clock in the issuer.

```js
const token = capabilities.issue().token;
assert.equal(
  (
    await fetch(url + '/api/diagnostics', {
      headers: { host: 'localhost' },
    })
  ).status,
  403,
);
assert.equal((await fetch(url + '/api/diagnostics?capability=' + token)).status, 403);
assert.equal(
  (
    await fetch(url + '/api/diagnostics', {
      headers: { cookie: `capability=${token}` },
    })
  ).status,
  403,
);
assert.equal(
  (
    await fetch(url + '/api/diagnostics', {
      headers: { authorization: `Bearer ${token}` },
    })
  ).status,
  200,
);
```

- [ ] **Step 2: Run `node --test apps/server/tests/http-security.test.mjs`; expect the no-token test to fail with status `200`.**
- [ ] **Step 3: Insert the capability guard before any snapshot or runtime call.** Preserve the current socket/Host comparison, require exact Bearer syntax, and set `cache-control: no-store` on both success and failure via the existing `send` helper. Do not put the bearer in query parsing, cookies, audit text, or error text.

```js
if (route === '/api/diagnostics') {
  const header = request.headers.authorization;
  const match = typeof header === 'string' && /^Bearer ([A-Za-z0-9_-]{43})$/.exec(header);
  if (!match || !diagnosticsCapabilities?.allows(match[1]))
    return send(response, 403, { error: 'Diagnostics authorization required.' });
  // Existing snapshot/stream selection follows only after this branch.
}
```

- [ ] **Step 4: Run `node --test apps/server/tests/http-security.test.mjs apps/server/tests/diagnostics-capabilities.test.mjs`; expect zero failures.** Verify the body of every denial contains no diagnostic stream/list/history data.
- [ ] **Step 5: Commit.** `git add apps/server/src/http-app.mjs apps/server/tests/http-security.test.mjs && git commit -m "fix: require owner capability for live diagnostics"`.

### Task 3: Deliver capability via explicit owner action and fragment-only browser bootstrap

**Files:** Create `apps/web-client/src/diagnostics-auth.js`, `apps/web-client/tests/diagnostics-bootstrap.test.mjs`; modify `apps/server/src/main.mjs`, `apps/server/src/http-app.mjs`, `apps/server/src/cli/commands.mjs`, `apps/server/src/cli/console.mjs`, `apps/web-client/src/diagnostics.js`, `apps/web-client/src/diagnostics.html`, `apps/windows-host/HostWindow.Layout.cs`, `apps/windows-host/HostWindow.Clients.cs`, `apps/windows-host/HostWindow.cs`; test `apps/server/tests/cli-console.test.mjs`, `apps/server/tests/http-security.test.mjs`, `apps/windows-host/tests/Navigation/App.xaml.cs`, `apps/windows-host/tests/Navigation/owner-fixture.mjs`.

**Interfaces:** Local owner message `{ type:'diagnostics-capability-create', requestId }` returns `{ type:'diagnostics-capability-result', requestId, ok, token, expiresAt }`. CLI `diagnostics open` issues a fresh URL only when called. The host's `OpenDiagnostics` requests one result and navigates to `${DiagnosticsAddress()}#capability=${encodeURIComponent(token)}`. Browser uses `takeDiagnosticsCapability(location, history) -> string | null` from `diagnostics-auth.js` and keeps the result in a module-local variable.

- [ ] **Step 1: Write failing owner/browser tests.** Assert no startup/ready/status line includes the token; one explicit command returns one token; the host routes `diagnostics-capability-result` to `ReceiveClientResult`; the browser removes `location.hash` before its first fetch and sends the bearer.

```js
const location = { hash: '#capability=abc', pathname: '/diagnostics', search: '?stream=x' };
const history = { replaceState: (...args) => replaced.push(args) };
const replaced = [];
assert.equal(takeDiagnosticsCapability(location, history), 'abc');
assert.deepEqual(replaced, [[null, '', '/diagnostics?stream=x']]);
```

- [ ] **Step 2: Run `node --test apps/server/tests/cli-console.test.mjs apps/web-client/tests/diagnostics-bootstrap.test.mjs` and `dotnet run --project apps/windows-host/tests/Navigation/Navigation.csproj`.** Expect missing bootstrap and owner-command assertions to fail.
- [ ] **Step 3: Wire explicit owner issuance and browser headers.** Instantiate one issuer in `main.mjs`, pass it to `createHttpApp`, and answer only the correlated local owner command. Change CLI startup copy from a bare diagnostics URL to “use `diagnostics open`”. Have Windows `OpenDiagnostics` await `SendClientOwnerCommand`, then `Process.Start` the fragment URL. Add `/diagnostics-auth.js` to the static allowlist. In the browser, strip the fragment before refresh; when absent/expired, show “Reopen Diagnostics from the host”. Do not persist the token in localStorage/sessionStorage.

```js
// diagnostics-auth.js
export function takeDiagnosticsCapability(location, history) {
  const token = new URLSearchParams(location.hash.slice(1)).get('capability');
  history.replaceState(null, '', location.pathname + location.search);
  return token;
}
// diagnostics.js
import { takeDiagnosticsCapability } from './diagnostics-auth.js';
let capability = takeDiagnosticsCapability(location, history);
const response = await fetch(
  '/api/diagnostics' + (selectedStream ? '?stream=' + encodeURIComponent(selectedStream) : ''),
  {
    headers: capability ? { authorization: `Bearer ${capability}` } : {},
    signal: AbortSignal.timeout(3000),
  },
);
if (response.status === 403) capability = null;
```

- [ ] **Step 4: Run `node --test apps/server/tests/http-security.test.mjs apps/server/tests/cli-console.test.mjs apps/web-client/tests/diagnostics-bootstrap.test.mjs`, `dotnet build apps/windows-host/VidVnc.Host.csproj`, and `npm test`; expect zero failures.** Exercise the host Diagnostics click and an expired page on a supported Windows desktop.
- [ ] **Step 5: Commit.** `git add apps/server/src/main.mjs apps/server/src/http-app.mjs apps/server/src/cli/commands.mjs apps/server/src/cli/console.mjs apps/web-client/src/diagnostics-auth.js apps/web-client/src/diagnostics.js apps/web-client/src/diagnostics.html apps/windows-host/HostWindow.Layout.cs apps/windows-host/HostWindow.Clients.cs apps/windows-host/HostWindow.cs apps/server/tests/cli-console.test.mjs apps/server/tests/http-security.test.mjs apps/web-client/tests/diagnostics-bootstrap.test.mjs apps/windows-host/tests/Navigation && git commit -m "feat: open diagnostics through owner-issued capability"`.

## Plan completion gate

Run `npm test`, `npm run format:check`, `dotnet build apps/windows-host/VidVnc.Host.csproj`, and the Windows navigation exercise. Inspect the live owner stdout and browser request history for token leakage. Reproduce the F4 same-host proxy case: loopback socket plus `Host: localhost` without a capability must return `403` and no live data; a valid bearer must work only while live. Note that a stolen bearer remains usable and remote release remains blocked by F3/F6.
