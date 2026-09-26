import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRelay, formatSessions } from '../src/cli/format.mjs';
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

test('sessions table shows the codec label for each stream', () => {
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
          streams: [
            {
              id: 'stream-a',
              name: 'Main',
              width: 1280,
              height: 720,
              targetFps: 15,
              profile: 'Mobile',
              viewers: 1,
              codec: 'h265',
            },
          ],
        },
      ],
    },
    new SessionNumbers(),
  );
  assert.match(text, /^\s*Stream\s+Display\s+Size\s+Target\s+Profile\s+Codec\s+Shared$/m);
  const [row] = text.split('\n').filter((line) => line.includes('stream-a'));
  assert.match(row, /\bH\.265\b/);
});

test('sessions table shows where media comes from and marks a different address', () => {
  const text = formatSessions(
    {
      sessions: [
        {
          id: 'session-a',
          device: 'iPhone',
          address: '172.20.10.2',
          health: 'Smooth',
          audio: false,
          control: 'View only',
          streams: [
            {
              id: 'same',
              name: 'Main',
              width: 1280,
              height: 720,
              targetFps: 15,
              profile: 'Mobile',
              mediaAddress: '203.0.113.9:53122',
              mediaDiffers: false,
            },
            {
              id: 'other',
              name: 'Main',
              width: 1280,
              height: 720,
              targetFps: 15,
              profile: 'Mobile',
              mediaAddress: '[2001:db8::9]:53123',
              mediaDiffers: true,
            },
          ],
        },
      ],
    },
    new SessionNumbers(),
  );
  assert.match(text, /^ {4}same media from 203\.0\.113\.9:53122$/m);
  assert.match(
    text,
    /^ {4}other media from \[2001:db8::9\]:53123 \(differs from the sign-in address\)$/m,
  );
});

test('media-relay shows the port, paths and drops, or why media is unavailable', () => {
  const metrics = {
    registrations: 2,
    pins: 1,
    forwarded: { toWorker: { packets: 900, bytes: 1 }, toClient: { packets: 12000, bytes: 1 } },
    dropped: { budget: 0, malformed: 14, 'bad-integrity': 3 },
    addressDiffers: 1,
  };
  assert.equal(
    formatRelay({
      state: 'listening',
      port: 4384,
      families: ['ipv6', 'ipv4'],
      reason: null,
      metrics,
    }),
    [
      'Media relay: listening on UDP 4384 (ipv6, ipv4)',
      'Streams registered: 2 · authenticated media paths: 1',
      'Forwarded: 900 datagrams in, 12000 out',
      'Dropped: malformed 14, bad-integrity 3',
      'Media from a different address than sign-in: 1 (allowed; iCloud Private Relay and carrier NAT do this)',
    ].join('\n'),
  );
  assert.equal(
    formatRelay({
      state: 'unavailable',
      port: 4384,
      families: [],
      reason: 'UDP 4384 is in use by another program. Choose another media port.',
      metrics: null,
    }),
    'Media relay: unavailable: UDP 4384 is in use by another program. Choose another media port.',
  );
  assert.equal(formatRelay(null), 'Media relay: not running.');
});
