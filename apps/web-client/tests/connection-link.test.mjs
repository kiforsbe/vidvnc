import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionKeyFromFragment } from '../src/connection-link.js';

test('reads and normalizes a connection key from a QR URL fragment', () => {
  assert.equal(connectionKeyFromFragment('#key=abcd-efgh'), 'ABCD-EFGH');
  assert.equal(connectionKeyFromFragment('key= ABCDEFGH '), 'ABCD-EFGH');
});

test('rejects malformed or absent QR connection keys', () => {
  for (const fragment of ['', '#key=abc', '#key=ABCD-EFGH-X', '#other=ABCD-EFGH', null])
    assert.equal(connectionKeyFromFragment(fragment), null);
});
