import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSessions } from '../src/cli/format.mjs';
import { SessionNumbers } from '../src/cli/resolve.mjs';

test('sessions table marks streams shared with other devices', () => {
  const stream = (id, viewers) => ({
    id,
    name: `Display ${id}`,
    width: 1280,
    height: 720,
    targetFps: 15,
    profile: 'Mobile',
    viewers,
  });
  const text = formatSessions(
    {
      sessions: [
        {
          id: 'bearer',
          device: 'iPhone',
          address: '10.0.0.2',
          health: 'Smooth',
          audio: false,
          control: 'View only',
          streams: [stream('shared-stream', 2), stream('own-stream', 1)],
        },
      ],
    },
    new SessionNumbers(),
  );
  assert.match(text, /Shared/);
  const [sharedRow] = text.split('\n').filter((line) => line.includes('shared-stream'));
  const [ownRow] = text.split('\n').filter((line) => line.includes('own-stream'));
  assert.match(sharedRow, /\s×2$/);
  assert.doesNotMatch(ownRow, /\s×\d+$/);
});
