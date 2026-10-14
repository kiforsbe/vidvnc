import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_PADS, PadSender, padMessage } from '../src/viewer/gamepad.js';

const pad = ({
  index = 0,
  mapping = 'standard',
  connected = true,
  pressed = [],
  axes,
  lt = 0,
} = {}) => ({
  index,
  mapping,
  connected,
  axes: axes ?? [0, 0, 0, 0],
  buttons: Array.from({ length: 17 }, (_, i) => ({
    pressed: pressed.includes(i),
    value: i === 6 ? lt : pressed.includes(i) ? 1 : 0,
  })),
});

test('a standard gamepad becomes one pad message in the standard layout', () => {
  assert.deepEqual(
    padMessage(pad({ index: 2, pressed: [0, 9, 12], axes: [0.5, -1, 0.12345, 1], lt: 0.25 })),
    {
      type: 'pad',
      index: 2,
      buttons: (1 << 0) | (1 << 9) | (1 << 12),
      lx: 0.5,
      ly: -1,
      rx: 0.123,
      ry: 1,
      lt: 0.25,
      rt: 0,
    },
  );
});

test('triggers travel only as lt and rt, and home is never sent', () => {
  const message = padMessage(pad({ pressed: [6, 7, 16], lt: 1 }));
  assert.equal(message.buttons, 0);
  assert.equal(message.lt, 1);
});

test('out-of-range and missing values are clamped, never passed on', () => {
  const message = padMessage(pad({ axes: [2, -5, Number.NaN] }));
  assert.deepEqual([message.lx, message.ly, message.rx, message.ry], [1, -1, 0, 0]);
  assert.equal(Object.is(padMessage(pad({ axes: [-0.0001, 0, 0, 0] })).lx, -0), false);
});

test('only connected standard pads among the first four are sent', () => {
  assert.equal(padMessage(pad({ mapping: '' })), null);
  assert.equal(padMessage(pad({ connected: false })), null);
  assert.equal(padMessage(pad({ index: MAX_PADS })), null);
  assert.equal(padMessage(null), null);
});

test('the sender sends changes only, and removes pads that go away', () => {
  const sent = [];
  const sender = new PadSender((message) => sent.push(message));
  sender.poll([pad()]);
  sender.poll([pad()]);
  assert.equal(sent.length, 1);
  sender.poll([pad({ pressed: [0] })]);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].buttons, 1);
  sender.poll([null]);
  assert.deepEqual(sent[2], { type: 'pad-remove', index: 0 });
  assert.equal(sender.active, false);
  sender.poll([pad()]);
  sender.reset();
  sender.poll([pad()]);
  assert.equal(sent.length, 5); // after a reset the whole state is sent again
});

test('a failed send is retried on the next poll', () => {
  let open = false;
  const sent = [];
  const sender = new PadSender((message) => (open ? sent.push(message) : false));
  sender.poll([pad()]);
  open = true;
  sender.poll([pad()]);
  assert.equal(sent.length, 1);
});
