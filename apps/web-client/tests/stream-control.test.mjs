import test from 'node:test';
import assert from 'node:assert/strict';
import { StreamSubscriptions } from '../src/stream-subscriptions.js';

// The Control button's request and release, with a fake server API and a selected stream
// whose input channel is open. No WebRTC is involved.
function setup(responses) {
  const calls = [];
  const controls = [];
  const peers = new StreamSubscriptions({
    api: async (route, body) => {
      calls.push([route, body]);
      const reply = responses[route];
      if (reply instanceof Error) throw reply;
      return reply;
    },
    onControl: (...args) => controls.push(args),
  });
  clearInterval(peers.timer);
  const row = { id: 'stream-1', channel: { readyState: 'open' } };
  peers.selected = row;
  return { peers, row, calls, controls };
}

test('a free, allowed stream can be requested, and the grant makes it allowed', async () => {
  const { peers, row, calls } = setup({
    'control-request': { controlStreamId: 'stream-1', controlRequestable: false },
  });
  peers.update({ controlStreamId: null, controlRequestable: true, streams: [] }, new Set());
  assert.equal(peers.allowed(row), false);
  assert.equal(peers.requestable(row), true);
  assert.equal(await peers.requestControl(), true);
  assert.deepEqual(calls, [['control-request', { streamId: 'stream-1' }]]);
  assert.equal(peers.allowed(row), true);
  assert.equal(peers.requestable(row), false);
});

test('nothing is requestable unless the server says so, and a refusal carries its reason', async () => {
  const { peers, row } = setup({
    'control-request': new Error('Another device has keyboard and mouse control.'),
  });
  peers.update({ controlStreamId: null, controlRequestable: false, streams: [] }, new Set());
  assert.equal(peers.requestable(row), false);
  row.channel.readyState = 'closed';
  peers.controlRequestable = true;
  assert.equal(peers.requestable(row), false);
  await assert.rejects(peers.requestControl(), /Another device/);
});

test('releasing hands control back and redraws the button from the server state', async () => {
  const { peers, row, calls, controls } = setup({
    'control-release': { controlStreamId: null, controlRequestable: true },
  });
  peers.controlStreamId = 'stream-1';
  peers.releaseControl();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['control-release', undefined]]);
  assert.equal(peers.allowed(row), false);
  assert.deepEqual(controls.at(-1), [false, false, true]);
});
