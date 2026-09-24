import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionStore } from '../src/session-store.mjs';
import { createOwnerSecurityCommands } from '../src/owner-security-commands.mjs';

test('owner downgrade invalidates synchronously and waits for native denial before success', async () => {
  const events = [];
  const sessions = new SessionStore({ maxSessions: 3 });
  const affected = sessions.connectApproved({ id: 'client-1', generation: 0 }).sessionId;
  const unrelated = sessions.connect(sessions.password).sessionId;
  let releaseNative;
  const native = new Promise((resolve) => {
    releaseNative = resolve;
  });
  let nativeStarted;
  const started = new Promise((resolve) => {
    nativeStarted = resolve;
  });
  const approvedClients = {
    invalidate(id, kind) {
      events.push(['invalidate', id, kind]);
    },
    async setPermission(id, permission) {
      events.push(['persist', id, permission]);
    },
  };
  const runtime = {
    async revokeApprovedClient(id) {
      events.push(['revoke', id]);
      nativeStarted();
      return native;
    },
    async stopSession(id) {
      events.push(['stop-session', id]);
    },
    async shutdown() {
      events.push(['shutdown']);
    },
  };
  const commands = createOwnerSecurityCommands({
    store: sessions,
    approvedClients,
    runtime,
  });
  const changing = commands.approved({
    action: 'permission',
    id: 'client-1',
    permission: 'view-only',
  });
  assert.deepEqual(events[0], ['invalidate', 'client-1', 'downgrade']);
  assert.equal(sessions.get(affected), null, 'old bearer is unusable immediately');
  assert.ok(sessions.get(unrelated), 'unrelated bearer remains live');
  await started;
  let settled = false;
  void changing
    .finally(() => {
      settled = true;
    })
    .catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(
    events.some(([type]) => type === 'persist'),
    false,
  );
  releaseNative({ nativeAck: true, peerTerminated: false });
  await changing;
  assert.deepEqual(
    events.map(([type]) => type),
    ['invalidate', 'revoke', 'stop-session', 'persist'],
  );
});

test('peer teardown fallback persists denial but returns a host-visible error', async () => {
  const events = [];
  const commands = createOwnerSecurityCommands({
    store: {
      list: () => [],
      stop() {
        events.push('stop');
      },
    },
    approvedClients: {
      invalidate() {
        events.push('deny');
      },
      async setPermission() {
        events.push('persist');
      },
    },
    runtime: {
      async revokeApprovedClient() {
        events.push('peer-terminated');
        return { nativeAck: false, peerTerminated: true };
      },
      async shutdown() {
        events.push('shutdown');
      },
    },
  });
  await assert.rejects(
    commands.approved({ action: 'permission', id: 'x', permission: 'view-only' }),
    /native.*peer/i,
  );
  assert.deepEqual(events, ['deny', 'peer-terminated', 'persist']);
});

test('failed persistence leaves denial in place and stops unsafe sharing', async () => {
  const events = [];
  const commands = createOwnerSecurityCommands({
    store: {
      list: () => [],
      stop() {
        events.push('stop');
      },
    },
    approvedClients: {
      invalidate() {
        events.push('deny');
      },
      async setPermission() {
        events.push('write-failed');
        throw new Error('disk failure');
      },
    },
    runtime: {
      async revokeApprovedClient() {
        return { nativeAck: true, peerTerminated: false };
      },
      async shutdown() {
        events.push('shutdown');
      },
    },
  });
  await assert.rejects(
    commands.approved({ action: 'permission', id: 'x', permission: 'view-only' }),
    /disk failure/i,
  );
  assert.deepEqual(events, ['deny', 'write-failed', 'stop', 'shutdown']);
});

test('failed native denial and peer teardown stops sharing without reporting success', async () => {
  const events = [];
  const commands = createOwnerSecurityCommands({
    store: {
      list: () => [],
      stop() {
        events.push('stop');
      },
    },
    approvedClients: {
      invalidate() {
        events.push('deny');
      },
      async setPermission() {
        events.push('persist');
      },
    },
    runtime: {
      async revokeApprovedClient() {
        events.push('native-failed');
        throw new Error('peer teardown failed');
      },
      async shutdown() {
        events.push('shutdown');
      },
    },
  });
  await assert.rejects(
    commands.approved({ action: 'permission', id: 'x', permission: 'view-only' }),
    /peer teardown failed/i,
  );
  assert.deepEqual(events, ['deny', 'native-failed', 'stop', 'shutdown']);
});

test('missing native acknowledgement without peer termination also stops sharing', async () => {
  const events = [];
  const commands = createOwnerSecurityCommands({
    store: {
      list: () => [],
      stop() {
        events.push('stop');
      },
    },
    approvedClients: {
      invalidate() {
        events.push('deny');
      },
      async setPermission() {
        events.push('persist');
      },
    },
    runtime: {
      async revokeApprovedClient() {
        return { nativeAck: false, peerTerminated: false };
      },
      async shutdown() {
        events.push('shutdown');
      },
    },
  });
  await assert.rejects(
    commands.approved({ action: 'permission', id: 'x', permission: 'view-only' }),
    /native.*denial/i,
  );
  assert.deepEqual(events, ['deny', 'stop', 'shutdown']);
});

test('approved removal waits for all matching sessions to end before acknowledging', async () => {
  const sessions = new SessionStore({ maxSessions: 2 });
  const approved = sessions.connectApproved({ id: 'client-1', generation: 0 }).sessionId;
  const ordinary = sessions.connect(sessions.password).sessionId;
  let releaseStop;
  const stopped = new Promise((resolve) => {
    releaseStop = resolve;
  });
  const events = [];
  const commands = createOwnerSecurityCommands({
    store: sessions,
    approvedClients: {
      invalidate() {
        events.push('deny');
      },
      async remove() {
        events.push('persist');
      },
    },
    runtime: {
      async revokeApprovedClient() {
        return { nativeAck: true, peerTerminated: false };
      },
      async stopSession(id) {
        events.push(['stop', id]);
        await stopped;
      },
      async shutdown() {},
    },
  });
  const removing = commands.approved({ action: 'remove', id: 'client-1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sessions.get(approved), null);
  assert.ok(sessions.get(ordinary));
  assert.equal(events.includes('persist'), false);
  releaseStop();
  await removing;
  assert.equal(events.includes('persist'), true);
});

test('switching future mode does not eject ordinary sessions; explicit lockdown does', async () => {
  const sessions = new SessionStore({ maxSessions: 2 });
  const ordinary = sessions.connect(sessions.password).sessionId;
  const approved = sessions.connectApproved({ id: 'client-1', generation: 0 }).sessionId;
  let connectionMode = 'session-key';
  connectionMode = 'approved-only';
  assert.equal(connectionMode, 'approved-only');
  assert.ok(sessions.get(ordinary));
  const stopped = [];
  const commands = createOwnerSecurityCommands({
    store: sessions,
    approvedClients: null,
    runtime: {
      async stopSession(id) {
        stopped.push(id);
      },
    },
  });
  assert.deepEqual(await commands.disconnectOrdinary(), { disconnected: 1 });
  assert.equal(sessions.get(ordinary), null);
  assert.ok(sessions.get(approved));
  assert.deepEqual(stopped, [ordinary]);
});
