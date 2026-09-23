import test from 'node:test';
import assert from 'node:assert/strict';
import {
  connectionKeyFromFragment,
  consumeConnectionKeyFromLocation,
} from '../src/connection-link.js';

test('reads and normalizes a connection key from a QR URL fragment', () => {
  assert.equal(connectionKeyFromFragment('#key=abcd-efgh'), 'ABCD-EFGH');
  assert.equal(connectionKeyFromFragment('key= ABCDEFGH '), 'ABCD-EFGH');
  assert.equal(connectionKeyFromFragment('#key=2a3b-4c5d'), '2A3B-4C5D');
});

test('rejects malformed or absent QR connection keys', () => {
  for (const fragment of ['', '#key=abc', '#key=ABCD-EFGH-X', '#other=ABCD-EFGH', null])
    assert.equal(connectionKeyFromFragment(fragment), null);
});

test('consumes a scanned key when Safari changes the fragment without reloading', () => {
  const location = { hash: '#key=abcd-efgh', pathname: '/', search: '?display=primary' };
  const calls = [];
  const history = { replaceState: (...args) => calls.push(args) };

  assert.equal(consumeConnectionKeyFromLocation(location, history), 'ABCD-EFGH');
  assert.deepEqual(calls, [[null, '', '/?display=primary']]);
});
