import test from 'node:test';
import assert from 'node:assert/strict';
import { announceCandidates, publicIpv4Addresses } from '../src/sdp-candidates.mjs';

const answer = [
  'v=0',
  'o=- 1 0 IN IP4 0.0.0.0',
  's=-',
  't=0 0',
  'm=video 40001 UDP/TLS/RTP/SAVPF 96',
  'c=IN IP4 192.168.1.20',
  'a=rtcp:9 IN IP4 192.168.1.20',
  'a=candidate:1 1 UDP 2015363327 192.168.1.20 40001 typ host',
  'a=candidate:2 1 TCP 1015021823 192.168.1.20 40002 typ host tcptype passive',
  'a=candidate:3 1 UDP 2015363071 172.20.0.1 40003 typ host',
  'a=candidate:4 1 UDP 2015363327 fe80::1 40004 typ host',
  'a=candidate:5 1 UDP 2015363327 2001:db8::20 40005 typ host',
  'a=end-of-candidates',
  '',
].join('\r\n');

test('an internet answer names the public address on the same ports, and no private one', () => {
  const rewritten = announceCandidates(answer, ['203.0.113.10']);
  assert.equal(rewritten.includes('192.168.'), false);
  assert.equal(rewritten.includes('172.20.'), false);
  assert.equal(rewritten.includes('fe80::'), false);
  const candidates = rewritten.split('\r\n').filter((line) => line.startsWith('a=candidate:'));
  assert.deepEqual(candidates, [
    'a=candidate:1p0 1 UDP 2015363327 203.0.113.10 40001 typ host',
    'a=candidate:2p0 1 TCP 1015021823 203.0.113.10 40002 typ host tcptype passive',
    'a=candidate:3p0 1 UDP 2015363071 203.0.113.10 40003 typ host',
    'a=candidate:5 1 UDP 2015363327 2001:db8::20 40005 typ host',
  ]);
  assert.match(rewritten, /\r\nc=IN IP4 203\.0\.113\.10\r\n/);
  assert.match(rewritten, /\r\na=rtcp:9 IN IP4 203\.0\.113\.10\r\n/);
  assert.match(rewritten, /\r\na=end-of-candidates\r\n$/);
});

test('without a public address private candidates are still removed', () => {
  const rewritten = announceCandidates(answer, []);
  assert.equal(rewritten.includes('a=candidate:1 '), false);
  assert.equal(rewritten.split('\r\n').filter((line) => line.startsWith('a=candidate:')).length, 1);
});

test('public addresses come from literals and DNS, private and failed lookups dropped', async () => {
  const resolve = async (name) => {
    if (name === 'vnc.example.com') return [{ address: '198.51.100.4' }, { address: '10.0.0.4' }];
    throw new Error('ENOTFOUND');
  };
  assert.deepEqual(
    await publicIpv4Addresses(
      ['203.0.113.10', 'vnc.example.com', 'gone.example.com', '2001:db8::1'],
      {
        resolve,
      },
    ),
    ['203.0.113.10', '198.51.100.4'],
  );
});

test('a DNS lookup that hangs is abandoned', async () => {
  const started = Date.now();
  assert.deepEqual(
    await publicIpv4Addresses(['slow.example.com'], {
      resolve: () => new Promise(() => {}),
      timeoutMs: 50,
    }),
    [],
  );
  assert.ok(Date.now() - started < 1000);
});
