# Approved-Client Revocation and Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close F2's stale-control authorization and F5's duplicate-session/removal races while retaining the user's copyable approved-browser credential.

**Architecture:** The approved-client store holds an in-memory authorization generation that invalidates synchronously on removal or downgrade. Session admission and every native control transition check the current generation; owner commands await durable state and native teardown before success. The session store independently enforces one live session per approved identity.

**Tech Stack:** Node.js 20.6+ ES modules, `node:test`, Windows host owner pipe and WinUI/C#.

**Spec:** [Selected Internet-exposure hardening design](../specs/2026-09-23-selected-internet-exposure-hardening-design.md), F2 and F5. Read the [source review](../../security/internet-exposure-review-2026-09-23.md) and [remediation proposals](../../security/internet-exposure-remediation-proposals-2026-09-23.md).

## Global Constraints

- Keep the current IndexedDB secret plus password; `installationId` is display metadata, not identity proof. Call this an **approved browser credential** and state explicitly that it remains copyable.
- At most one live session per approved-client ID; a second sign-in returns `409` without evicting the first. Existing session expiry is 20 seconds after an abrupt close.
- A downgrade/removal invalidates its authorization generation synchronously before any asynchronous persistence work. Removal blocks new admission and tears down all matching sessions and control before host success.
- Every grant and renewal checks the current record/generation after asynchronous native work. Revocation success requires `setPermission(false)` acknowledgment or completed peer teardown; native failure is not reported as success.
- A failed persistence operation keeps access denied in the process, surfaces a host error, and stops unsafe sharing; it must not roll back to control-capable state.
- Changing future `approved-only` admission is separate from the explicit owner action that disconnects existing ordinary sessions.
- This plan does not make the copyable credential device-bound or resolve F3/F6 remote-release gates.

## Review Focus

- Removing a client while its password `scrypt` is paused must never admit that client afterward; Task 1 injects a deferred verifier.
- A copied credential attempting a second sign-in while the legitimate session is live must receive `409` and leave the first session alive; Task 2 tests both IDs.
- A `view-only` change during a pending native grant must remove the grant before the command resolves; Task 3 controls the worker acknowledgment.
- A native revoke timeout must end the peer and return an owner error, not a success that merely updated JSON; Task 4 tests the owner result ordering.
- A mode switch to `approved-only` must not silently eject ordinary sessions; the separate lockdown command must; Task 4 tests both paths.

## File structure and interfaces

- `apps/server/src/approved-clients.mjs` owns record generations, synchronous invalidation, durable writes, and post-`scrypt` revalidation. `apps/server/src/approved-client-permission.mjs` is a pure effective-permission helper shared by admission and runtime.
- `apps/server/src/session-store.mjs` owns the one-live-session invariant and rollback on failed `markConnected`.
- `apps/server/src/stream-runtime.mjs` owns current permission checks and awaited session teardown. `apps/server/src/control-lease.mjs` remains the sole serialized native grant/revoke coordinator.
- `apps/server/src/http-app.mjs` owns final sign-in revalidation and distinct conflict response. New `apps/server/src/owner-security-commands.mjs` owns awaited owner-command revocation/lockdown; `apps/server/src/main.mjs` only decodes and acknowledges the command.
- `apps/windows-host/HostWindow.Layout.cs` and `HostWindow.Clients.cs` show precise security state and the lockdown action. `apps/web-client/src/app.js` displays the already-in-use response.

---

### Task 1: Make approved-client authorization generation synchronous

**Files:** Create `apps/server/src/approved-client-permission.mjs`; modify `apps/server/src/approved-clients.mjs`; test `apps/server/tests/approved-clients.test.mjs` and new `apps/server/tests/approved-client-permission.test.mjs`.

**Interfaces:** `authorization(clientId) -> { id, generation, permission } | null`; `stillAuthorized(snapshot) -> boolean`; `invalidate(clientId, kind) -> generation` synchronously; `effectivePermission(authorization, accessDefault) -> 'approval'|'available'|'view-only'`. `authenticate()` returns the authorization generation with identity metadata, then verifies it still matches after `scrypt`. `invalidate` inserts an in-memory deny tombstone; `setPermission` may clear it only after a successful durable write, and `remove` retains it permanently for that ID. A failed write leaves the tombstone in place.

- [ ] **Step 1: Write failing tests for removal during verifier work, downgrade generation, and pure permission resolution.** Inject a deferred `verifyPassword` dependency in `ApprovedClientStore.open` so the race is deterministic.

```js
let release;
const gate = new Promise((resolve) => {
  release = resolve;
});
const checking = store.authenticate(credential);
await verifierStarted;
const old = store.authorization(clientId);
store.invalidate(clientId, 'remove');
assert.equal(store.stillAuthorized(old), false);
release();
assert.equal(await checking, null);
assert.equal(effectivePermission({ permission: 'view-only' }, 'available'), 'view-only');
```

- [ ] **Step 2: Run `node --test apps/server/tests/approved-clients.test.mjs apps/server/tests/approved-client-permission.test.mjs`.** Expect the missing authorization API/helper test to fail.
- [ ] **Step 3: Add the generation map and effective-permission helper.** Keep generations in process memory, increment synchronously before queuing a `remove` or downgrade write, and never reuse a removed ID. `invalidate` marks the ID denied before returning. `setPermission` clears denial only after its atomic write succeeds; a persisted `view-only` row remains denied for control through `effectivePermission`. Capture `{ id, generation }` before verification and re-read after it. Allow a test-only verifier dependency, defaulting to the existing `passwordVerifier`.

```js
export function effectivePermission(auth, accessDefault) {
  if (!auth) return 'view-only';
  return auth.permission === 'default' ? accessDefault : auth.permission;
}
authorization(id) {
  const row = this.#value.clients.find((item) => item.id === id);
  return row && !this.#denied.has(id)
    ? { id, generation: this.#generations.get(id) ?? 0, permission: row.permission }
    : null;
}
stillAuthorized(snapshot) {
  const current = snapshot && this.authorization(snapshot.id);
  return !!current && current.generation === snapshot.generation;
}
```

- [ ] **Step 4: Run the two focused suites; expect zero failures.** Confirm old credential-format tests still pass. Do not claim physical device binding.
- [ ] **Step 5: Commit.** `git add apps/server/src/approved-client-permission.mjs apps/server/src/approved-clients.mjs apps/server/tests/approved-clients.test.mjs apps/server/tests/approved-client-permission.test.mjs && git commit -m "feat: invalidate approved-client authorization synchronously"`.

### Task 2: Enforce one live approved session and close sign-in races

**Files:** Modify `apps/server/src/session-store.mjs`, `apps/server/src/http-app.mjs`, `apps/server/src/approved-clients.mjs`, `apps/web-client/src/app.js`; test `apps/server/tests/session-store.test.mjs`, `apps/server/tests/approved-client-http.test.mjs`, `apps/web-client/tests/approved-client.test.mjs`.

**Interfaces:** `SessionStore.connectApproved(approved, source, userAgent)` accepts the `generation` from Task 1 and returns `{ ok:false, reason:'already-in-use' }` for a second live ID. `ApprovedClientStore.markConnected(id, generation)` refuses stale generations. HTTP `409` has a stable `code: 'approved-client-in-use'` for browser copy.

- [ ] **Step 1: Write failing duplicate and remove-vs-`markConnected` tests.** Keep `maxSessions: 2` so global capacity is not mistaken for identity conflict.

```js
const sessions = new SessionStore({ maxSessions: 2 });
const approved = { id: 'client-1', generation: 0, permission: 'available' };
const first = sessions.connectApproved(approved);
const second = sessions.connectApproved(approved);
assert.equal(first.ok, true);
assert.deepEqual(second, { ok: false, reason: 'already-in-use' });
assert.ok(sessions.get(first.sessionId));
sessions.disconnect(first.sessionId);
assert.equal(sessions.connectApproved(approved).ok, true);
```

- [ ] **Step 2: Run `node --test apps/server/tests/session-store.test.mjs apps/server/tests/approved-client-http.test.mjs apps/web-client/tests/approved-client.test.mjs`.** Expect duplicate-session assertion to fail.
- [ ] **Step 3: Add synchronous identity admission and final HTTP recheck.** After `authenticate` and `connectionPlan`, call `stillAuthorized` immediately before `connectApproved` with no intervening await. `markConnected(id, generation)` rechecks inside the queued operation; if it rejects, disconnect the newly created session and await `runtime?.stopSession(admission.sessionId)` before sending an error. Do not let a copied credential displace the existing session.

```js
if (!approvedClients.stillAuthorized(approved))
  return send(response, 401, { error: 'Unable to authenticate.' });
const admission = sessionStore.connectApproved(approved, source, userAgent);
if (admission.reason === 'already-in-use')
  return send(response, 409, {
    code: 'approved-client-in-use',
    error: 'This approved browser credential is already in use.',
  });
```

- [ ] **Step 4: Run the three focused suites; expect zero failures.** Ensure the browser renders “already in use” without telling the user that the physical device is protected against copies.
- [ ] **Step 5: Commit.** `git add apps/server/src/session-store.mjs apps/server/src/http-app.mjs apps/server/src/approved-clients.mjs apps/web-client/src/app.js apps/server/tests/session-store.test.mjs apps/server/tests/approved-client-http.test.mjs apps/web-client/tests/approved-client.test.mjs && git commit -m "feat: contain approved credential to one live session"`.

### Task 3: Recheck current permission for every native control transition

**Files:** Modify `apps/server/src/stream-runtime.mjs`, `apps/server/src/control-lease.mjs`; test `apps/server/tests/stream-runtime.test.mjs`, `apps/server/tests/control-lease.test.mjs`.

**Interfaces:** `StreamRuntime.currentControl(sessionId, streamId, { explicitOwner = false }) -> boolean` checks live session/stream/worker plus current approved-client authorization; `StreamRuntime.revokeApprovedClient(clientId) -> Promise<{ nativeAck: boolean, peerTerminated: boolean }>` drops automatic eligibility and awaits `ControlLease.revoke` for affected owners. `ControlLease.isActive` continues to guard grant before and after native `setPermission(true)`, and renewal before and after acknowledgment. Extend `ControlLease.revoke` to return the native-ack/fallback result.

- [ ] **Step 1: Write failing controlled-worker tests for downgrade before select, during grant, and at renewal.** Use the existing fake media object and a deferred permission acknowledgment.

```js
const granting = runtime.command({ action: 'grant', sessionId, streamId });
await nativeGrantStarted;
approvedClients.invalidate(clientId, 'downgrade');
releaseNativeGrant(true);
await assert.rejects(granting, /inactive|view only/i);
assert.equal(runtime.control.owner, null);
assert.ok(events.some(([id, allowed]) => id === streamId && allowed === false));
```

- [ ] **Step 2: Run `node --test apps/server/tests/stream-runtime.test.mjs apps/server/tests/control-lease.test.mjs`.** Expect the grant race or stale auto-control test to fail.
- [ ] **Step 3: Put current permission in the lease's `isActive` callback and in `selectStream`.** Treat a missing/removed approved record as deny. An explicit owner grant to an `approval` client remains possible; automatic grant requires current `available`. Clear `automaticControl` on downgrade; make `revokeApprovedClient` await the serialized native revoke and peer-removal fallback. The existing post-ack `isActive` check closes the in-flight grant race.

```js
const current = approvedClientId && approvedClients.authorization(approvedClientId);
const permission = current
  ? effectivePermission(current, access.snapshot().defaultControl)
  : approvedClientId
    ? 'view-only'
    : access.snapshot().defaultControl;
const canGrant = explicitOwner ? permission !== 'view-only' : permission === 'available';
if (!canGrant) throw new Error('Current permission denies control');
// ControlLease.#release returns the evidence awaited by the owner command.
try {
  if ((await this.media.setPermission(previous.streamId, false)) !== false)
    throw new Error('Worker refused control revoke');
  return { nativeAck: true, peerTerminated: false };
} catch {
  await this.media.removePeer(previous.streamId);
  return { nativeAck: false, peerTerminated: true };
}
```

- [ ] **Step 4: Run both focused suites; expect zero failures.** Assert `setPermission(false)` or peer removal completes before `revokeApprovedClient` resolves.
- [ ] **Step 5: Commit.** `git add apps/server/src/stream-runtime.mjs apps/server/src/control-lease.mjs apps/server/tests/stream-runtime.test.mjs apps/server/tests/control-lease.test.mjs && git commit -m "fix: enforce current permission at every control transition"`.

### Task 4: Await owner revocation and add explicit ordinary-session lockdown

**Files:** Create `apps/server/src/owner-security-commands.mjs`, `apps/server/tests/owner-security-commands.test.mjs`; modify `apps/server/src/main.mjs`, `apps/server/src/stream-runtime.mjs`, `apps/server/src/approved-clients.mjs`, `apps/server/src/cli/commands.mjs`, `apps/server/src/cli/console.mjs`, `apps/windows-host/HostWindow.Layout.cs`, `apps/windows-host/HostWindow.Clients.cs`; test `apps/server/tests/cli-console.test.mjs`, `apps/server/tests/stream-runtime.test.mjs`, `apps/windows-host/tests/Navigation/App.xaml.cs`, `apps/windows-host/tests/Navigation/owner-fixture.mjs`.

**Interfaces:** `createOwnerSecurityCommands({ store, approvedClients, runtime }) -> { approved(command), disconnectOrdinary() }`. Owner `approved-client-command` results only after durable removal/downgrade and completed `runtime.stopSession()`/`runtime.revokeApprovedClient()`. New owner command `ordinary-sessions-disconnect` invokes `SessionStore.disconnect` for each `approvedClientId === null` then awaits runtime teardown. CLI `disconnect-ordinary` and a separate host action call that command; `connectionMode` changes remain future-admission only.

- [ ] **Step 1: Add owner-protocol ordering tests.** Block fake native `setPermission(false)` and assert no `client-command-result ok:true` is emitted; release it and assert success. Simulate native refusal/peer teardown failure and a failed approved-clients write; assert host error and denial remain. Assert mode switch preserves an ordinary session and `ordinary-sessions-disconnect` removes it.

```js
const commands = createOwnerSecurityCommands({ store, approvedClients, runtime });
const changing = commands.approved({
  action: 'permission',
  id: clientId,
  permission: 'view-only',
});
let settled = false;
void changing
  .finally(() => {
    settled = true;
  })
  .catch(() => {});
await nativeRevokeStarted;
assert.equal(settled, false);
releaseNativeRevoke(false);
await assert.rejects(changing, /native denial/i);
assert.equal(runtime.control.owner, null);
```

- [ ] **Step 2: Run `node --test apps/server/tests/owner-security-commands.test.mjs apps/server/tests/cli-console.test.mjs apps/server/tests/stream-runtime.test.mjs` and `dotnet run --project apps/windows-host/tests/Navigation/Navigation.csproj`.** Expect the new owner command and UI assertions to fail.
- [ ] **Step 3: Reorder owner commands to fail closed.** Call `invalidate()` synchronously at owner-command dispatch, clear automatic eligibility, await native revoke/teardown, then await persistence and acknowledge. If the native worker refuses revocation but peer teardown completes, persist the downgrade/removal but return `ok:false` with an explicit teardown warning. If both acknowledgment and teardown fail, stop sharing and return `ok:false`. On a persistence failure, keep denial, invoke `runtime.stopAll()` and surface `ok:false`. For removal, disconnect every matching session and await `runtime.stopSession(id)` before host success. Add the separate ordinary-disconnect command/UI with confirmation; do not tie it to `access-set`.

```js
const affected = store.list().filter((row) => row.approvedClientId === command.id);
approvedClients.invalidate(command.id, command.action === 'remove' ? 'remove' : 'downgrade');
const revoked = await runtime.revokeApprovedClient(command.id);
if (command.action === 'remove') {
  for (const row of affected) store.disconnect(row.sessionId);
  await Promise.all(affected.map((row) => runtime.stopSession(row.sessionId)));
  await approvedClients.remove(command.id);
} else {
  await approvedClients.setPermission(command.id, command.permission);
}
if (!revoked.nativeAck) throw new Error('Native denial was not acknowledged; peer terminated');
```

- [ ] **Step 4: Run `node --test apps/server/tests/owner-security-commands.test.mjs apps/server/tests/approved-clients.test.mjs apps/server/tests/stream-runtime.test.mjs apps/server/tests/cli-console.test.mjs`, `dotnet build apps/windows-host/VidVnc.Host.csproj`, and `npm test`; expect zero failures.** Run the Windows navigation and native-worker timeout exercises before release.
- [ ] **Step 5: Commit.** `git add apps/server/src/owner-security-commands.mjs apps/server/src/main.mjs apps/server/src/stream-runtime.mjs apps/server/src/approved-clients.mjs apps/server/src/cli/commands.mjs apps/server/src/cli/console.mjs apps/windows-host/HostWindow.Layout.cs apps/windows-host/HostWindow.Clients.cs apps/server/tests/owner-security-commands.test.mjs apps/server/tests/cli-console.test.mjs apps/server/tests/stream-runtime.test.mjs apps/windows-host/tests/Navigation && git commit -m "fix: await approved-client revocation and expose lockdown"`.

## Plan completion gate

Run `npm test`, `npm run format:check`, `dotnet build apps/windows-host/VidVnc.Host.csproj`, the Windows navigation exercise, and a real native-worker revoke-timeout test. Confirm duplicate sign-in, remove-vs-verifier, remove-vs-`markConnected`, downgrade-during-grant, renewal, and failed persistence all end without usable control. Describe F2/F5 as addressed per the selected design, with credential cloneability and remote-release blockers still open.
