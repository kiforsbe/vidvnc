// Isolated owner-pipe fixture: real policy persistence/controller, no capture or sockets.
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StreamPolicyStore } from '../../../server/src/stream-policy-store.mjs';
import { PolicyController } from '../../../server/src/policy-controller.mjs';
import { SessionStore } from '../../../server/src/session-store.mjs';
import { AccessSettings } from '../../../server/src/access-settings.mjs';

const directory = await mkdtemp(join(tmpdir(), 'vidvnc-native-policy-test-'));
try {
  const filename = join(directory, 'policy.json');
  const store = await StreamPolicyStore.open(filename);
  const accessFile = join(directory, 'access.json');
  const access = await AccessSettings.open(accessFile);
  const controller = new PolicyController(store, new SessionStore(), { shutdown: async () => {} });
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (message.type === 'access-set') {
      try {
        await access.replace(message.defaultControl, message.revision);
        console.log(JSON.stringify({ type: 'access-result', requestId: message.requestId, ok: true,
          access: (await AccessSettings.open(accessFile)).snapshot() }));
      } catch (error) {
        console.log(JSON.stringify({ type: 'access-result', requestId: message.requestId, ok: false,
          error: error.message, access: access.snapshot() }));
      }
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
