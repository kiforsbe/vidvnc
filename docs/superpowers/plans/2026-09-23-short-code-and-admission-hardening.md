# Short-Code and Admission Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close F1's key oracle/rate-limit bypass and F7's unbounded admission state while preserving an eight-character, host-issued code workflow and a local-only standing session password.

**Architecture:** A validated access-settings extension defines bounded policy. A purpose-neutral key registry, shared admission controller, local-network gate, and one-use registration-ticket store sit behind one metered `/api/key-start` route. Browser, CLI, and native host present the same code lifecycle; no remote listener or F3/F6 transport mode is introduced.

**Tech Stack:** Node.js 20.6+ ES modules and `node:test`, browser JavaScript, WinUI/C# host, existing JSON settings/owner pipe.

**Spec:** [Selected Internet-exposure hardening design](../specs/2026-09-23-selected-internet-exposure-hardening-design.md), F1/F7 and CLI/config sections. Read the [source review](../../security/internet-exposure.md) before changing the HTTP entry points.

## Global Constraints

- Codes are exactly eight random symbols; no symbol encodes purpose. `letters-digits` is `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (~39.6 bits); `letters` is `ABCDEFGHJKMNPQRSTUVWXYZ` (~36.2 bits).
- A standing session password is accepted only from loopback or an eligible selected on-link private LAN and never on a handler marked `public`; no forwarding header grants locality.
- One ephemeral one-time/setup code exists at a time, only after an explicit owner command. Default TTL is 300 seconds; valid configured range is 60–600 seconds. It is single-use and never auto-renewed.
- Default global failure cap is 20 per ephemeral issuance and 20 per local session-password generation; configuration may only set 1–20. Default per-source cap is 5, configurable 1–5 and no greater than global.
- On the 20th failure, short-code admission locks until an explicit owner issuance or password rotation; a bot can cause denial of service, never a fail-open reset.
- Native host exposes only `letters-digits`/`letters` alphabet choice in Connect device, not TTL, attempt limits, or CIDRs. CLI/config exposes all validated fields.
- A redeemed setup code yields a 256-bit registration ticket valid for ten minutes; it is consumed only by one successful registration submission.
- F3, F6, and cryptographic F5 device binding remain out of scope; passing this plan is not Internet-release approval.

## Review Focus

- Eight-character input containing `0`, `1`, `I`, `L`, or `O` must fail generically without truncation or an alphabet alias; Task 2 tests both browser normalization and registry parsing.
- Twenty parallel bad guesses from rotating sources must consume one global budget atomically; Task 3 tests this before any HTTP lookup.
- A valid code submitted after its expiry, after use, or while all session slots are occupied must never create an extra session or silently extend its life; Tasks 2 and 5 test each state.
- A public handler receiving a loopback peer from a same-host proxy must still reject the standing session password; Task 4 tests listener scope independently of CIDR.
- Opening the native dialog, changing its type, or changing CLI settings must not mint/extend a code; Task 6 tests explicit issuance and snapshots of active-code settings.

## File structure and interfaces

- `apps/server/src/access-settings.mjs` remains the validated `access-settings.json` owner. `apps/server/src/cli/commands/settings.mjs`, completion, and CLI tests own read/set commands.
- `apps/server/src/connection-keys.mjs` owns alphabets, generation, record purpose, expiry, and atomic one-use consumption. `apps/web-client/src/password-entry.js` owns shared, purpose-neutral input normalization.
- New `apps/server/src/admission-budget.mjs` owns bounded per-source/global counters and `scrypt` concurrency leases. It never trusts forwarding headers.
- New `apps/server/src/local-session-scope.mjs` owns local peer decisions; new `apps/server/src/windows-lan-adapters.mjs` only reads/classifies Windows adapter/profile metadata. The HTTP handler receives a listener scope explicitly.
- `apps/server/src/approved-clients.mjs` owns ten-minute registration tickets and pending-registration TTL/cap. `apps/server/src/http-app.mjs` owns one metered key-start route and generic responses.
- `apps/web-client/src/app.js`, `index.html`, `style.css`, and `connection-link.js` own the browser flow. `apps/windows-host/HostWindow.Layout.cs`, `HostWindow.Clients.cs`, and `HostWindow.cs` own explicit native issuance, alphabet choice, countdown, and reply handling. `apps/server/src/main.mjs` and CLI commands own local issuer commands.

---

### Task 1: Validate security settings and expose CLI controls

**Files:** Modify `apps/server/src/access-settings.mjs`, `apps/server/src/cli/commands/settings.mjs`, `apps/server/src/cli/completion.mjs`; test `apps/server/tests/access-settings.test.mjs`, `apps/server/tests/cli-commands.test.mjs`, `apps/server/tests/cli-completion.test.mjs`.

**Interfaces:** Produces `AccessSettings.snapshot()` fields `shortCodeTtlSeconds`, `shortCodeMaxFailures`, `shortCodePerSourceMaxFailures`, `sessionPasswordMaxFailures`, `defaultCodeAlphabet`, `localSessionNetworks`; later tasks read a snapshot at code issuance. CLI command names are `code-ttl`, `code-attempts`, `code-source-attempts`, `session-password-attempts`, `code-alphabet`, `local-session-networks`.

- [ ] **Step 1: Write failing settings and CLI tests.** Add assertions to the named suites, including the cross-field bound.

```js
const access = await AccessSettings.open(filename);
assert.equal(access.snapshot().shortCodeTtlSeconds, 300);
assert.equal(access.snapshot().shortCodeMaxFailures, 20);
assert.equal(access.snapshot().defaultCodeAlphabet, 'letters-digits');
await assert.rejects(
  access.replace({ shortCodePerSourceMaxFailures: 6 }, access.snapshot().revision),
  /code.*source/i,
);
await assert.rejects(
  access.replace(
    { shortCodeMaxFailures: 3, shortCodePerSourceMaxFailures: 5 },
    access.snapshot().revision,
  ),
  /source.*global/i,
);
```

- [ ] **Step 2: Confirm the new tests fail.** Run `node --test apps/server/tests/access-settings.test.mjs apps/server/tests/cli-commands.test.mjs apps/server/tests/cli-completion.test.mjs`; expect failures naming the missing fields/commands, not fixture errors.
- [ ] **Step 3: Extend the existing schema and CLI command table.** Merge defaults before validation and keep the existing revisioned atomic write. Use the same `context.saveAccess` path as `connection-mode`; CLI arguments are integers with exact ranges, `local-session-networks` accepts `auto` or comma-separated CIDRs, and `code-alphabet` accepts only the two enum values.

```js
const SECURITY_DEFAULTS = Object.freeze({
  shortCodeTtlSeconds: 300,
  shortCodeMaxFailures: 20,
  shortCodePerSourceMaxFailures: 5,
  sessionPasswordMaxFailures: 20,
  defaultCodeAlphabet: 'letters-digits',
  localSessionNetworks: 'auto',
});
const bounded = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;
if (!bounded(next.shortCodeTtlSeconds, 60, 600)) throw new Error('Invalid short-code TTL');
if (!bounded(next.shortCodeMaxFailures, 1, 20))
  throw new Error('Invalid short-code global failure limit');
if (
  !bounded(next.shortCodePerSourceMaxFailures, 1, 5) ||
  next.shortCodePerSourceMaxFailures > next.shortCodeMaxFailures
)
  throw new Error('Short-code source limit exceeds global limit');
```

- [ ] **Step 4: Verify settings and CLI tests pass.** Run the same `node --test` command; expect zero failures. Run `node apps/server/src/main.mjs config help` and confirm all six commands are listed.
- [ ] **Step 5: Commit.** `git add apps/server/src/access-settings.mjs apps/server/src/cli/commands/settings.mjs apps/server/src/cli/completion.mjs apps/server/tests/access-settings.test.mjs apps/server/tests/cli-commands.test.mjs apps/server/tests/cli-completion.test.mjs && git commit -m "feat: validate short-code security settings"`.

### Task 2: Generate purpose-neutral eight-character keys

**Files:** Modify `apps/server/src/connection-keys.mjs`, `apps/web-client/src/password-entry.js`; test `apps/server/tests/connection-keys.test.mjs`, `apps/web-client/tests/password-entry.test.mjs`, `apps/web-client/tests/connection-link.test.mjs`.

**Interfaces:** Produces `CODE_ALPHABETS`, `ConnectionKeyRegistry({ clock, alphabet })`, `rotateSession(alphabet, limits)`, `createSetup({ ttlMs, alphabet, limits })`, `createOneTimeConnection({ ttlMs, alphabet, limits })`, `activeEphemeral() -> { generation, globalLimit, sourceLimit } | null`, `activeSession() -> { generation, globalLimit, sourceLimit } | null`, `inspect(key)`, and `use(key, purpose)`. `inspect` returns a record with server-held `purpose`; the browser gets no purpose decoder. A random generation ID and limit snapshot are stored per issuance. Only one ephemeral record is retained.

- [ ] **Step 1: Replace the old purpose-prefix tests with format, entropy, expiry, and single-use tests.** Use an injected clock to avoid sleeps.

```js
assert.equal(CODE_ALPHABETS['letters-digits'].length, 31);
assert.equal(CODE_ALPHABETS.letters.length, 23);
let now = 0;
const keys = new ConnectionKeyRegistry({ clock: () => now, alphabet: 'letters-digits' });
const once = keys.createOneTimeConnection({ ttlMs: 300_000, alphabet: 'letters' });
assert.match(once.key, /^[ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/);
const setup = keys.createSetup({ ttlMs: 300_000, alphabet: 'letters-digits' });
assert.equal(keys.inspect(once.key), null);
assert.equal(keys.inspect(setup.key).purpose, 'approved-client-setup');
now += 300_000;
assert.equal(keys.inspect(setup.key), null);
assert.equal(normalizePassword('12OI-ABCD'), null);
```

- [ ] **Step 2: Run `node --test apps/server/tests/connection-keys.test.mjs apps/web-client/tests/password-entry.test.mjs apps/web-client/tests/connection-link.test.mjs`.** Expect failures on exported alphabets and eight-character digit handling.
- [ ] **Step 3: Implement unbiased generation, no purpose code, and shared normalization.** Keep CSPRNG rejection sampling (`randomBytes`); store purpose only in the registry record; revoke the prior ephemeral lookup before issuing a new one.

```js
export const CODE_ALPHABETS = Object.freeze({
  'letters-digits': '23456789ABCDEFGHJKMNPQRSTUVWXYZ',
  letters: 'ABCDEFGHJKMNPQRSTUVWXYZ',
});
function generate(alphabet) {
  const symbols = CODE_ALPHABETS[alphabet];
  if (!symbols) throw new Error('Invalid code alphabet');
  let raw = '';
  while (raw.length < 8) raw += symbols[randomIndex(symbols.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
export function normalizePassword(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim().toUpperCase().replace(/-/g, '');
  if (!/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{8}$/.test(raw)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}
```

- [ ] **Step 4: Re-run the focused tests and the browser entry test.** Run `node --test apps/server/tests/connection-keys.test.mjs apps/web-client/tests/password-entry.test.mjs apps/web-client/tests/connection-link.test.mjs`; expect zero failures. Update `formatPasswordEntry` and the eight-cell segmented-entry filter in `password-entry.js` to permit the same alphabet; do not replace an invalid symbol with a guess.
- [ ] **Step 5: Commit.** `git add apps/server/src/connection-keys.mjs apps/web-client/src/password-entry.js apps/server/tests/connection-keys.test.mjs apps/web-client/tests/password-entry.test.mjs apps/web-client/tests/connection-link.test.mjs && git commit -m "feat: issue purpose-neutral eight-character codes"`.

### Task 3: Bound anonymous admission and password work

**Files:** Create `apps/server/src/admission-budget.mjs`, `apps/server/tests/admission-budget.test.mjs`; modify `apps/server/src/session-store.mjs`, `apps/server/src/approved-clients.mjs`; test `apps/server/tests/session-store.test.mjs`, `apps/server/tests/approved-clients.test.mjs`.

**Interfaces:** Produces `AdmissionBudget({ clock, maxSources = 1024 })` with `beginKeyStart(source, { ephemeral, session }) -> { ok, allowsPurpose(purpose), finish(purpose, valid) }`, `beginSignIn(source, clientId) -> { ok, finish() }`, `beginStatus(source) -> { ok, finish() }`, and `withScrypt(work) -> Promise`. `ephemeral` and `session` contain their generation and limit snapshot. Before parsing/lookup, `beginKeyStart` reserves capacity in every active, not-yet-exhausted key class; it denies when neither has capacity. Invalid/malformed keys charge every reserved class; valid keys release the other class and count no failure in their own. This permits a valid session key after the ephemeral budget is spent without allowing an exhausted ephemeral key through. The outer rolling request budget also applies before lookup. In-flight reservations occupy budget until `finish`; success never erases prior failures.

- [ ] **Step 1: Write deterministic failure/concurrency tests.** Include 20 parallel rotating-source attempts, 5 same-source attempts, oldest-entry eviction, clock rollover, and four active `scrypt` leases.

```js
let now = 0;
const budget = new AdmissionBudget({ clock: () => now, maxSources: 3 });
const policy = {
  ephemeral: { generation: 'issue-1', globalLimit: 20, sourceLimit: 5 },
  session: null,
};
const attempts = Array.from({ length: 20 }, (_, i) =>
  budget.beginKeyStart(`198.51.100.${i}`, policy),
);
assert.equal(attempts.filter((entry) => entry.ok).length, 20);
assert.equal(budget.beginKeyStart('198.51.100.40', policy).ok, false);
attempts.forEach((entry) => entry.finish(null, false));
assert.equal(budget.beginKeyStart('198.51.100.40', policy).ok, false);
assert.equal(
  budget.beginKeyStart('198.51.100.40', {
    ...policy,
    ephemeral: { ...policy.ephemeral, generation: 'issue-2' },
  }).ok,
  true,
);
const releases = [];
const blockedWork = () =>
  new Promise((resolve) => {
    releases.push(resolve);
  });
const jobs = Array.from({ length: 4 }, () => budget.withScrypt(blockedWork));
await assert.rejects(budget.withScrypt(blockedWork), /busy/i);
releases.forEach((resolve) => resolve());
await Promise.all(jobs);
```

- [ ] **Step 2: Run `node --test apps/server/tests/admission-budget.test.mjs apps/server/tests/session-store.test.mjs apps/server/tests/approved-clients.test.mjs`.** Expect `AdmissionBudget` import failure first.
- [ ] **Step 3: Implement the bounded counters and remove the two 1,024-entry hard lockouts.** `reserveClass(kind, source, config)` checks the generation-specific global/source failure-plus-pending caps, increments pending, and returns `{ accepts(purpose), finish(outcome) }`; `finish(false)` charges a failure, while `finish(true)` or `finish(null)` only releases pending. `reserveRolling(route, source, global, perSource, windowMs)` charges the outer budget before lookup. Reserve each available key-class slot synchronously before any `await`; no two parallel HTTP requests can see the same last slot. Evict oldest per-source counters when full, but never evict or bypass a global counter. Separate ephemeral and session-password generations reset only on corresponding explicit issuance/rotation. Charge malformed JSON as failure in a `try/finally` around parsing. Use a separate 120/min global sign-in/registration budget and 600/min status budget, with 10/source/min and 10/client-ID/min on sign-in and 60/source/min on status. `withScrypt` rejects above four concurrent jobs without building a queue.

```js
beginKeyStart(source, { ephemeral, session }) {
  if (!this.reserveRolling('key-start', source, 120, 10, 60_000))
    return { ok: false };
  const reserved = [
    this.reserveClass('ephemeral', source, ephemeral),
    this.reserveClass('session', source, session),
  ].filter(Boolean);
  if (!reserved.length) return { ok: false };
  let settled = false;
  return { ok: true,
    allowsPurpose: (purpose) => reserved.some((item) => item.accepts(purpose)),
    finish: (purpose, valid) => {
    if (settled) return;
    settled = true;
    for (const item of reserved)
      item.finish(valid ? (item.accepts(purpose) ? true : null) : false);
  } };
}
async withScrypt(work) {
  if (this.activeScrypt >= 4) throw new Error('Password verification busy');
  this.activeScrypt++;
  try { return await work(); }
  finally { this.activeScrypt--; }
}
```

- [ ] **Step 4: Run the focused suites; expect zero failures.** Also run `node --test apps/server/tests/approved-client-http.test.mjs` to identify old-route assertions for Task 5 rather than silently changing them here.
- [ ] **Step 5: Commit.** `git add apps/server/src/admission-budget.mjs apps/server/src/session-store.mjs apps/server/src/approved-clients.mjs apps/server/tests/admission-budget.test.mjs apps/server/tests/session-store.test.mjs apps/server/tests/approved-clients.test.mjs && git commit -m "feat: bound admission attempts and password work"`.

### Task 4: Classify local session-password peers independently of proxy headers

**Files:** Create `apps/server/src/local-session-scope.mjs`, `apps/server/src/windows-lan-adapters.mjs`, `apps/server/tests/local-session-scope.test.mjs`; modify `apps/server/src/http-app.mjs` constructor options and `apps/server/src/main.mjs` listener setup.

**Interfaces:** Produces `createLocalSessionScope({ adapters, networkProfiles, override })` with `allows(peerAddress, listenerScope) -> boolean`, where `listenerScope` is exactly `'local'` or `'public'`. `windows-lan-adapters.mjs` supplies adapter/profile/address rows; tests inject rows and never query the real machine.

- [ ] **Step 1: Write scope tests for Private physical LAN, Public Wi-Fi, VPN/virtual adapters, off-link overrides, IPv4-mapped IPv6, and a proxied public listener.**

```js
const scope = createLocalSessionScope({
  adapters: [
    {
      kind: 'wifi',
      physical: true,
      profile: 'Private',
      address: '192.168.10.12',
      prefixLength: 24,
    },
  ],
  override: 'auto',
});
assert.equal(scope.allows('192.168.10.44', 'local'), true);
assert.equal(scope.allows('::ffff:192.168.10.44', 'local'), true);
assert.equal(scope.allows('203.0.113.9', 'local'), false);
assert.equal(scope.allows('127.0.0.1', 'public'), false);
assert.equal(scope.allows('127.0.0.1', 'local'), true);
```

- [ ] **Step 2: Run `node --test apps/server/tests/local-session-scope.test.mjs`; expect missing-module failure.**
- [ ] **Step 3: Implement pure CIDR classification and a read-only Windows metadata adapter.** Use a fixed PowerShell command with no user interpolation to collect `Get-NetAdapter`, `Get-NetConnectionProfile`, and `Get-NetIPAddress` rows as JSON; normalize each output row to `{ kind: 'ethernet'|'wifi', physical: boolean, up: boolean, profile: 'Private'|'Public', address: string, prefixLength: number }`. Require `physical`, `up`, `Private`, Ethernet/Wi-Fi, and private on-link addresses. A detector failure yields loopback-only plus a host-visible reason. Normalize IPv4-mapped IPv6 before `net.BlockList.check`; always reject `listenerScope === 'public'` first.

```js
allows(peerAddress, listenerScope) {
  if (listenerScope === 'public') return false;
  if (listenerScope !== 'local') throw new Error('Invalid listener scope');
  const peer = peerAddress?.startsWith('::ffff:') ? peerAddress.slice(7) : peerAddress;
  if (peer === '127.0.0.1' || peer === '::1') return true;
  return this.allowedCidrs.some((cidr) => cidrContains(cidr, peer));
}
```

- [ ] **Step 4: Run the scope suite and add an HTTP test with `listenerScope: 'public'` and a loopback socket.** Expect the session password to be rejected even when the request uses `Host: localhost`; do not rely on `X-Forwarded-For`.
- [ ] **Step 5: Commit.** `git add apps/server/src/local-session-scope.mjs apps/server/src/windows-lan-adapters.mjs apps/server/src/http-app.mjs apps/server/src/main.mjs apps/server/tests/local-session-scope.test.mjs apps/server/tests/http-security.test.mjs && git commit -m "feat: gate standing password to local listener scope"`.

### Task 5: Replace key inspection with a metered start and registration ticket

**Files:** Modify `apps/server/src/http-app.mjs`, `apps/server/src/approved-clients.mjs`, `apps/server/src/session-store.mjs`; test `apps/server/tests/approved-client-http.test.mjs`, `apps/server/tests/http-security.test.mjs`, `apps/server/tests/approved-clients.test.mjs`.

**Interfaces:** `POST /api/key-start { key, ...connectionPlan }` returns `201` with a session or `202 { registrationTicket, expiresAt }`. `POST /api/approved-clients/register` accepts `registrationTicket`; `ApprovedClientStore.issueRegistrationTicket()` and `submit({ registrationTicket, ...fields })` enforce one successful use and a ten-minute TTL. Keep `/api/connect`, `/api/connection-key`, and direct-key registration only as **metered compatibility paths** until Task 6 atomically migrates the browser and removes them; never ship the intermediate commit as a release.

- [ ] **Step 1: Add HTTP registration and connection tests around the new contract while retaining old-route tests until Task 6.** Include malformed request accounting, expired ticket, duplicate ticket use, wrong listener scope, occupied slots, and the temporary metering of the old oracle. Add fake-clock tests for 64 pending requests, ten-minute pending/rejected/approved-unclaimed expiry, oldest claim cleanup, and durable removal of an approved credential whose secret was never claimed.

```js
const setup = server.sessionStore.keys.createSetup({ ttlMs: 300_000 });
const start = await post(url, 'key-start', { key: setup.key });
assert.equal(start.status, 202);
const { registrationTicket } = await start.json();
const registration = await post(url, 'approved-clients/register', {
  registrationTicket,
  deviceName: 'Phone',
  username: 'kim',
  password: 'correct horse battery staple',
  installationId: 'browser-1',
  client: 'Safari',
});
assert.equal(registration.status, 202);
assert.equal(
  (
    await post(url, 'approved-clients/register', {
      registrationTicket,
      deviceName: 'Phone',
      username: 'kim',
      password: 'correct horse battery staple',
      installationId: 'browser-1',
      client: 'Safari',
    })
  ).status,
  401,
);
```

- [ ] **Step 2: Run `node --test apps/server/tests/approved-client-http.test.mjs apps/server/tests/http-security.test.mjs apps/server/tests/approved-clients.test.mjs`; expect failures for old route behavior.**
- [ ] **Step 3: Route every authentication attempt through admission before `readJson`.** `key-start` reserves a short-code attempt, verifies/uses the code, and either calls `sessionStore.connect` or returns a registration ticket. `register` validates ticket before `scrypt` and atomically consumes it after successful validation. Filter expired claims on synchronous status/access, await `sweepExpired()` in asynchronous store operations, and run it on a 60-second periodic timer with host-visible errors; refuse the 65th live pending request, expire pending/rejected/approved-unclaimed claims after 600,000 ms, and durably remove any unclaimed approved record. Make invalid/wrong-purpose/expired responses identical, but keep a valid occupied connection code unconsumed for retry until expiry. Charge and cap the compatibility routes before parsing/lookup too, then remove them in Task 6.

```js
if (route === '/api/key-start') {
  const attempt = admission.beginKeyStart(request.socket.remoteAddress, {
    ephemeral: sessionStore.keys.activeEphemeral(),
    session: sessionStore.keys.activeSession(),
  });
  if (!attempt.ok)
    return send(response, 429, { error: 'Try again after a new host code is issued.' });
  let body;
  try {
    body = await readJson(request);
  } catch {
    attempt.finish(null, false);
    return send(response, 400, { error: 'Unable to authenticate.' });
  }
  const record = sessionStore.keys.inspect(body.key);
  if (!record || !attempt.allowsPurpose(record.purpose)) {
    attempt.finish(null, false);
    return send(response, 401, { error: 'Unable to authenticate.' });
  }
  if (
    record.purpose === CONNECTION_KEY_PURPOSES.session &&
    !localSessionScope.allows(request.socket.remoteAddress, listenerScope)
  ) {
    attempt.finish(null, false);
    return send(response, 401, { error: 'Unable to authenticate.' });
  }
  if (record.purpose === CONNECTION_KEY_PURPOSES.setup) {
    sessionStore.keys.use(body.key, record.purpose);
    attempt.finish(record.purpose, true);
    return send(response, 202, approvedClients.issueRegistrationTicket());
  }
  if (!ordinaryKeyAllowed(record.purpose)) {
    attempt.finish(null, false);
    return send(response, 401, { error: 'Unable to authenticate.' });
  }
  let plan;
  try {
    plan = connectionPlan(body, request);
  } catch (error) {
    attempt.finish(null, false);
    return send(response, 403, { error: error.message });
  }
  const result = sessionStore.connect(body.key, request.socket.remoteAddress);
  attempt.finish(record.purpose, result.ok || result.reason === 'busy');
  return sendAdmission(response, result, plan);
}
// ApprovedClientStore: asynchronous cleanup is awaited by writes and a 60 s timer.
async sweepExpired() {
  for (const [id, row] of this.#pending) {
    if (this.clock() - row.requestedAt < 600_000) continue;
    this.#pending.delete(id);
    if (row.state === 'approved' && !row.claimed) {
      await this.remove(row.clientId);
    }
  }
}
```

- [ ] **Step 4: Run the three focused suites, then `node tools/test.mjs server`; expect zero failures.** Fix old test fixtures that intentionally called `/api/connect` so they assert the new public contract rather than suppressing failures.
- [ ] **Step 5: Commit.** `git add apps/server/src/http-app.mjs apps/server/src/approved-clients.mjs apps/server/src/session-store.mjs apps/server/tests/approved-client-http.test.mjs apps/server/tests/http-security.test.mjs apps/server/tests/approved-clients.test.mjs && git commit -m "feat: meter key start and ticketed registration"`.

### Task 6: Complete browser, owner CLI, and native-host code lifecycle

**Files:** Modify `apps/web-client/src/app.js`, `apps/web-client/src/index.html`, `apps/web-client/src/style.css`, `apps/windows-host/HostWindow.Layout.cs`, `apps/windows-host/HostWindow.Clients.cs`, `apps/windows-host/HostWindow.cs`, `apps/server/src/main.mjs`, `apps/server/src/cli/commands.mjs`, `apps/server/src/cli/console.mjs`; test `apps/web-client/tests/password-entry.test.mjs`, `apps/server/tests/cli-console.test.mjs`, `apps/windows-host/tests/Navigation/App.xaml.cs`, `apps/windows-host/tests/Navigation/owner-fixture.mjs`.

**Interfaces:** Browser posts one `/api/key-start`; registration form carries only the returned ticket. Owner pipe accepts `connection-once-create { requestId, alphabet }`, `client-setup-create { requestId, alphabet }`, and `session-password-rotate { requestId, alphabet }`; result includes `key`, `expiresAt` where applicable, and effective alphabet. Explicit CLI commands issue the same requests locally.

- [ ] **Step 1: Add a browser-flow test and native navigation assertions.** Opening or switching the dialog must leave code fields empty until Generate is clicked; selecting `letters` then Generate sends `alphabet: 'letters'`; selecting `letters-digits` then rotating the session password changes only new admission. Test that `SessionStore.rotateConnectionKey()` leaves an existing session live; do not call the current `rotatePassword()` path that deliberately disconnects sessions for stop/shutdown. The navigation test uses a `ComboBox` tagged `code-alphabet` and a button tagged `generate-code`, added in Step 3.

```csharp
var dialog = (ContentDialog)createConnectionDialog.Invoke(window, new object[] { "connect-once" })!;
var alphabet = Descendants(dialog).OfType<ComboBox>()
    .Single(control => Equals(control.Tag, "code-alphabet"));
var generate = Descendants(dialog).OfType<Button>()
    .Single(control => Equals(control.Tag, "generate-code"));
if (alphabet.SelectedIndex != 0) throw new Exception("Letters and numbers is the default");
if (!generate.IsEnabled) throw new Exception("Code issuance requires a visible owner action");
```

- [ ] **Step 2: Run `node --test apps/web-client/tests/password-entry.test.mjs apps/server/tests/cli-console.test.mjs` and `dotnet run --project apps/windows-host/tests/Navigation/Navigation.csproj`.** Expect the new selector/button assertion to fail before the control is added.
- [ ] **Step 3: Replace browser inspection with one call; add explicit Generate controls and owner commands.** On success, route by the response's `registrationTicket` field and submit that ticket from the registration form, never the short code. Keep URL-fragment key consumption and history scrubbing. The native selector supplies an enum, never an arbitrary alphabet. The host clears an expired code and QR, displays `expiresAt`, and never auto-issues another. Wire the three exact live-owner CLI commands through `createLiveContext`; show status/lockout and do not mint on a settings read.

```js
const started = await api('key-start', {
  key: normalizePassword($('password').value),
  ...currentRequest,
});
if (started.registrationTicket) {
  registrationTicket = started.registrationTicket;
  showAuthentication('registerForm');
} else {
  await startStream(started, attempt);
}
```

- [ ] **Step 4: Remove the compatibility routes and verify browser, CLI, and host.** Add `assert.equal((await post(url, 'connection-key', { key: 'AAAA-AAAA' })).status, 404)` and the same assertion for `connect` to `approved-client-http.test.mjs`; remove those route cases and direct-key registration from `http-app.mjs`/`ApprovedClientStore`. Run `node --test apps/web-client/tests/password-entry.test.mjs apps/web-client/tests/connection-link.test.mjs apps/server/tests/cli-console.test.mjs apps/server/tests/approved-client-http.test.mjs`, `dotnet build apps/windows-host/VidVnc.Host.csproj`, and `npm test`; expect zero failures. Run the Windows navigation exercise on a supported desktop before release.
- [ ] **Step 5: Commit.** `git add apps/web-client/src/app.js apps/web-client/src/index.html apps/web-client/src/style.css apps/windows-host/HostWindow.Layout.cs apps/windows-host/HostWindow.Clients.cs apps/windows-host/HostWindow.cs apps/server/src/main.mjs apps/server/src/cli/commands.mjs apps/server/src/cli/console.mjs apps/web-client/tests apps/server/tests/cli-console.test.mjs apps/windows-host/tests/Navigation && git commit -m "feat: expose explicit eight-character code issuance"`.

## Plan completion gate

Run `npm test`, `npm run format:check`, `dotnet build apps/windows-host/VidVnc.Host.csproj`, and the Windows navigation/hardware tests available on the target host. Reproduce F1's original eight-bad-guess scenario against the real HTTP route: attempts must lock, never proceed to key lookup after exhaustion, and a valid key must not be admitted while locked. Record that this plan does not make the service Internet-ready; F3/F6 and the F5 credential choice remain open.
