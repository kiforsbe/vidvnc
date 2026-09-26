import test from 'node:test';
import assert from 'node:assert/strict';
import {
  announceCandidates,
  announceRelay,
  iceCredentials,
  publicIpv4Addresses,
  stripOfferCandidates,
  validateRelayAnswer,
} from '../src/sdp-candidates.mjs';

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

test('an internet client offer keeps only candidates on public addresses', async () => {
  const { filterOfferCandidates } = await import('../src/sdp-candidates.mjs');
  const offer = [
    'v=0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'c=IN IP4 0.0.0.0',
    'a=candidate:1 1 udp 2122260223 192.168.1.40 55000 typ host',
    'a=candidate:2 1 udp 2122260223 3d7f9c1a-1111-2222-3333-444455556666.local 55001 typ host',
    'a=candidate:3 1 tcp 1518280447 10.0.0.9 9 typ host tcptype active',
    'a=candidate:4 1 udp 2122260223 fe80::1 55002 typ host',
    'a=candidate:5 1 udp 1686052607 198.51.100.20 61000 typ srflx raddr 0.0.0.0 rport 0',
    'a=candidate:6 1 udp 2122260223 2001:db8::40 55003 typ host',
    'a=candidate:7 1 udp 2122260223 attacker.example 22 typ host',
    'a=end-of-candidates',
    '',
  ].join('\r\n');
  const filtered = filterOfferCandidates(offer).split('\r\n');
  assert.deepEqual(
    filtered.filter((line) => line.startsWith('a=candidate:')).map((line) => line.split(' ')[0]),
    ['a=candidate:5', 'a=candidate:6'],
  );
  assert.ok(filtered.includes('c=IN IP4 0.0.0.0'));
  assert.ok(filtered.includes('a=end-of-candidates'));
});

// --- Media relay helpers.

const relayAnswer = [
  'v=0',
  'o=- 4611731400430051336 0 IN IP4 0.0.0.0',
  's=-',
  't=0 0',
  'a=group:BUNDLE video0',
  'a=ice-options:trickle',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'c=IN IP4 127.0.0.1',
  'a=rtcp:9 IN IP4 127.0.0.1',
  'a=mid:video0',
  'a=sendonly',
  'a=rtcp-mux',
  'a=ice-ufrag:WkR1',
  'a=ice-pwd:0123456789abcdefghijklmn',
  'a=setup:active',
  'a=fingerprint:sha-256 AA:BB',
  'a=rtpmap:96 H264/90000',
  'a=rtcp-fb:96 nack pli',
  'a=ssrc:10000001 msid:user1 video0',
  'a=candidate:1 1 UDP 2015363327 127.0.0.1 51234 typ host',
  'a=end-of-candidates',
  '',
].join('\r\n');

test('offers lose every candidate but keep their ICE credentials', () => {
  const offer = [
    'v=0',
    'a=ice-ufrag:Cli3',
    'a=ice-pwd:abcdefghijklmnopqrstuvwx',
    'a=candidate:1 1 udp 2122260223 192.168.1.30 55000 typ host',
    'a=candidate:2 1 udp 2122260223 abc.local 55001 typ host',
    'a=end-of-candidates',
  ].join('\r\n');
  const stripped = stripOfferCandidates(offer);
  assert.equal(stripped.includes('a=candidate'), false);
  assert.deepEqual(iceCredentials(stripped), {
    ufrag: 'Cli3',
    pwd: 'abcdefghijklmnopqrstuvwx',
  });
});

test('a relay-mode answer yields its credentials and loopback port', () => {
  assert.deepEqual(validateRelayAnswer(relayAnswer), {
    ufrag: 'WkR1',
    pwd: '0123456789abcdefghijklmn',
    port: 51234,
  });
});

test('answers with other candidates, extra candidates or unexpected lines are refused', () => {
  const swap = (from, to) => relayAnswer.replace(from, to);
  for (const bad of [
    swap('127.0.0.1 51234', '192.168.1.20 51234'),
    swap(' UDP ', ' TCP '),
    swap('typ host', 'typ srflx raddr 0.0.0.0 rport 0'),
    swap('127.0.0.1 51234', '127.0.0.1 80'),
    swap(
      'a=end-of-candidates',
      'a=candidate:2 1 UDP 2015363327 127.0.0.1 51235 typ host\r\na=end-of-candidates',
    ),
    swap('a=end-of-candidates', 'a=x-injected:1'),
    swap('a=ice-pwd:0123456789abcdefghijklmn', 'a=ice-pwd:short'),
    relayAnswer + 'x'.repeat(70000),
  ])
    assert.throws(() => validateRelayAnswer(bad));
});

test('the relay address replaces the loopback candidate for each client', () => {
  const internet = announceRelay(relayAnswer, ['203.0.113.10', '2001:db8::5'], 4384);
  assert.equal(internet.includes('127.0.0.1'), false);
  assert.deepEqual(
    internet.split('\r\n').filter((line) => line.startsWith('a=candidate:')),
    [
      'a=candidate:1r0 1 UDP 2015363327 203.0.113.10 4384 typ host',
      'a=candidate:1r1 1 UDP 2015363326 2001:db8::5 4384 typ host',
    ],
  );
  assert.ok(internet.includes('c=IN IP4 203.0.113.10'));
  assert.ok(internet.includes('a=ice-ufrag:WkR1'));

  const lan = announceRelay(relayAnswer, ['fd00::20%12'], 4384);
  assert.ok(lan.includes('a=candidate:1r0 1 UDP 2015363327 fd00::20 4384 typ host'));
  assert.ok(lan.includes('c=IN IP6 fd00::20'));
  assert.throws(() => announceRelay(relayAnswer, ['not-an-address'], 4384));
});
