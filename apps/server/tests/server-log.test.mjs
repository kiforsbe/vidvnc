import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createServerLog } from '../src/server-log.mjs';

test('the desktop server log persists native negotiation failures', async () => {
  const printed = [];
  const written = [];
  const directory = join(process.cwd(), 'out', 'test-temp', 'server-log');
  const log = createServerLog({
    desktop: true,
    directory,
    now: () => new Date('2026-09-22T16:30:00.000Z'),
    consoleError: (message) => printed.push(message),
    makeDirectory: async () => {},
    append: async (path, text) => written.push([path, text]),
  });

  await log('[native-media source] Peer negotiation failed: Invalid SDP');

  assert.deepEqual(printed, ['[native-media source] Peer negotiation failed: Invalid SDP']);
  assert.deepEqual(written, [
    [
      join(directory, 'server.log'),
      '2026-09-22T16:30:00.000Z [native-media source] Peer negotiation failed: Invalid SDP\n',
    ],
  ]);
});
