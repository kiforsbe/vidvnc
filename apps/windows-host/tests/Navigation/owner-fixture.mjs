// Isolated owner-pipe fixture: real policy persistence/controller, no capture or sockets.
// Its replies follow the owner protocol contract the server is held to
// (apps/server/tests/fixtures/owner-protocol/, checked by owner-protocol.test.mjs), with an
// extra `received` field echoing what the host sent.
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamPolicyStore } from '../../../server/src/stream-policy-store.mjs';
import { PolicyController } from '../../../server/src/policy-controller.mjs';
import { SessionStore } from '../../../server/src/session-store.mjs';
import { AccessSettings } from '../../../server/src/access-settings.mjs';
import { ConnectionKeyRegistry } from '../../../server/src/connection-keys.mjs';

const contract = JSON.parse(
  await readFile(
    new URL('../../../server/tests/fixtures/owner-protocol/replies.json', import.meta.url),
    'utf8',
  ),
);
const diagnostics = contract['diagnostics-capability-result'][0];
const directory = await mkdtemp(join(tmpdir(), 'vidvnc-native-policy-test-'));
try {
  const filename = join(directory, 'policy.json');
  const store = await StreamPolicyStore.open(filename);
  const accessFile = join(directory, 'access.json');
  const access = await AccessSettings.open(accessFile);
  const controller = new PolicyController(store, new SessionStore(), { shutdown: async () => {} });
  const keys = new ConnectionKeyRegistry();
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (message.type === 'diagnostics-capability-create') {
      console.log(JSON.stringify({ type: 'diagnostics-capability-result', requestId: message.requestId,
        ok: true, token: diagnostics.token, expiresAt: Date.now() + 900_000,
        url: diagnostics.url,
        received: { type: message.type } }));
      continue;
    }
    if (message.type === 'client-setup-create') {
      const setup = keys.createSetup({ ttlMs: 5 * 60_000, alphabet: message.alphabet });
      console.log(JSON.stringify({ type: 'client-setup-result', requestId: message.requestId,
        ok: true, key: setup.key, expiresAt: setup.expiresAt, alphabet: setup.alphabet,
        received: { type: message.type, alphabet: message.alphabet } }));
      continue;
    }
    if (message.type === 'connection-once-create') {
      const once = keys.createOneTimeConnection({ ttlMs: 5 * 60_000, alphabet: message.alphabet });
      console.log(JSON.stringify({ type: 'connection-once-result', requestId: message.requestId,
        ok: true, key: once.key, expiresAt: once.expiresAt, alphabet: once.alphabet,
        received: { type: message.type, alphabet: message.alphabet } }));
      continue;
    }
    if (message.type === 'session-password-rotate') {
      const key = keys.rotateSession(message.alphabet);
      console.log(JSON.stringify({ type: 'session-password-result', requestId: message.requestId,
        ok: true, key, alphabet: message.alphabet,
        received: { type: message.type, alphabet: message.alphabet } }));
      continue;
    }
    if (message.type === 'client-request-command' || message.type === 'approved-client-command' || message.type === 'ordinary-sessions-disconnect') {
      console.log(JSON.stringify({ type: 'client-command-result', requestId: message.requestId,
        ok: true, ...(message.type === 'ordinary-sessions-disconnect' ? { disconnected: 0 } : {}),
        received: { type: message.type, action: message.action, id: message.id,
          permission: message.permission } }));
      continue;
    }
    if (message.type === 'access-set') {
      try {
        const { type, requestId, revision, ...changes } = message;
        await access.replace(changes, revision);
        console.log(JSON.stringify({ type: 'access-result', requestId: message.requestId, ok: true,
          access: (await AccessSettings.open(accessFile)).snapshot() }));
      } catch (error) {
        console.log(JSON.stringify({ type: 'access-result', requestId: message.requestId, ok: false,
          error: error.message, access: access.snapshot() }));
      }
      continue;
    }
    if (message.type === 'tls-regenerate') {
      // No certificate tooling is reached here, ever: the fixture only proves the host sent
      // the command and can consume the reply. Real reissue behaviour is proven by the
      // server's own tls tests.
      console.log(
        JSON.stringify({
          type: 'tls-regenerate-result',
          ok: true,
          received: { type: message.type },
        }),
      );
      continue;
    }
    if (message.type === 'session-command') {
      console.log(JSON.stringify({ type: 'session-result', requestId: message.requestId, ok: true,
        received: { action: message.action, sessionId: message.sessionId, streamId: message.streamId } }));
      continue;
    }
    try {
      await controller.replace(message.policy, message.revision, message.disconnect);
      const persisted = await StreamPolicyStore.open(filename);
      console.log(JSON.stringify({ type: 'policy-result', requestId: message.requestId, ok: true, policy: persisted.snapshot() }));
    } catch (error) {
      console.log(JSON.stringify({ type: 'policy-result', requestId: message.requestId, ok: false, error: error.message, policy: controller.snapshot() }));
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
