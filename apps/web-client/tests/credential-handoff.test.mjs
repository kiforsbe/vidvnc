import test from 'node:test';
import assert from 'node:assert/strict';
import {
  consumeCredentialFromLocation,
  credentialFromFragment,
  credentialHandoffUrl,
} from '../src/approved-client.js';

const credential = {
  clientId: '9b2f6d1e-0000-4000-8000-000000000001',
  clientSecret: 'x'.repeat(43),
  username: 'kim å',
};

test('a handoff link carries the key to the public HTTPS origin in the fragment', () => {
  const link = credentialHandoffUrl('https://vnc.example.com:8443/some/path?q=1', credential);
  const url = new URL(link);
  assert.equal(url.origin, 'https://vnc.example.com:8443');
  assert.equal(url.pathname, '/');
  assert.equal(url.search, '');
  assert.deepEqual(credentialFromFragment(url.hash), credential);
});

test('only HTTPS remote addresses and valid keys make a link', () => {
  assert.throws(() => credentialHandoffUrl('http://vnc.example.com', credential), /HTTPS/);
  assert.throws(
    () => credentialHandoffUrl('https://vnc.example.com', { clientId: 'x' }),
    /Invalid/,
  );
});

test('malformed or invalid fragments give no key', () => {
  for (const fragment of [
    '',
    '#key=ABCD-EFGH',
    '#approved=not-base64!!',
    '#approved=' + Buffer.from('{"clientId":"a"}').toString('base64url'),
    '#approved=' + 'A'.repeat(2000),
    null,
  ])
    assert.equal(credentialFromFragment(fragment), null, String(fragment));
});

test('consuming a handoff removes it from the address bar, valid or not', () => {
  const replaced = [];
  const history = { replaceState: (_, __, url) => replaced.push(url) };
  const link = new URL(credentialHandoffUrl('https://vnc.example.com', credential));
  assert.deepEqual(
    consumeCredentialFromLocation({ hash: link.hash, pathname: '/', search: '' }, history),
    credential,
  );
  assert.equal(
    consumeCredentialFromLocation({ hash: '#approved=broken', pathname: '/', search: '' }, history),
    null,
  );
  assert.deepEqual(replaced, ['/', '/']);
  assert.equal(
    consumeCredentialFromLocation({ hash: '#key=ABCD-EFGH', pathname: '/', search: '' }, history),
    null,
  );
  assert.equal(replaced.length, 2, 'other fragments are left alone');
});
