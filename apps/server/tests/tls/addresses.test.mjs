import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attemptAndAnnounce,
  connectionAddresses,
  secureAddressLines,
} from '../../src/tls/addresses.mjs';
import * as addressModule from '../../src/tls/addresses.mjs';
import { liveConsole } from '../fixtures/cli-live-console.mjs';

const nic = (address, extra = {}) => ({ address, family: 'IPv4', internal: false, ...extra });
const interfaces = () => ({
  Ethernet: [nic('192.168.1.5'), { address: 'fe80::1', family: 'IPv6', internal: false }],
  'Wi-Fi': [nic('10.0.0.7')],
  Loopback: [nic('127.0.0.1', { internal: true }), nic('::1', { family: 'IPv6', internal: true })],
});
const off = { active: false, port: null };
const on = (port = 4383) => ({ active: true, port });
const boundHttp = (port = 4382) => [
  { host: '192.168.1.5', port },
  { host: '10.0.0.7', port },
  { host: '127.0.0.1', port },
];

test('local HTTP roots come only from bound private/loopback listeners with bracketed IPv6', () => {
  assert.equal(typeof addressModule.httpConnectionAddresses, 'function');
  const shown = addressModule.httpConnectionAddresses([
    { host: '127.0.0.1', port: 4382 },
    { host: '192.168.10.12', port: 4382 },
    { host: 'fd12::42', port: 4382 },
    { host: '::1', port: 4382 },
  ]);
  assert.deepEqual(shown.lan, ['http://192.168.10.12:4382', 'http://[fd12::42]:4382']);
  assert.equal(shown.local, 'http://127.0.0.1:4382');
  assert.deepEqual(shown.urls, [
    'http://192.168.10.12:4382',
    'http://[fd12::42]:4382',
    'http://127.0.0.1:4382',
    'http://[::1]:4382',
  ]);
});

test('required HTTPS with an inactive listener advertises no HTTP viewer addresses', () => {
  assert.deepEqual(
    connectionAddresses({
      interfaces,
      plaintextPort: 4382,
      httpBindings: [{ host: '127.0.0.1', port: 4382 }],
      tls: off,
      plaintextMode: 'https-required',
    }),
    { lan: [], local: null, urls: [] },
  );
});

test('an explicit HTTPS loopback bind does not advertise unbound LAN HTTPS addresses', () => {
  assert.deepEqual(
    connectionAddresses({
      interfaces,
      plaintextPort: 4382,
      httpBindings: [{ host: '127.0.0.1', port: 4382 }],
      tls: on(4383),
      plaintextMode: 'https-required',
      hostPreference: '127.0.0.1',
    }).urls,
    ['https://127.0.0.1:4383'],
  );
});

test('deliberate HTTP mode shows only the bound plaintext addresses', () => {
  assert.deepEqual(connectionAddresses({ interfaces, httpBindings: boundHttp(), tls: off }), {
    lan: ['http://192.168.1.5:4382', 'http://10.0.0.7:4382'],
    local: 'http://127.0.0.1:4382',
    urls: ['http://192.168.1.5:4382', 'http://10.0.0.7:4382', 'http://127.0.0.1:4382'],
  });
});

test('omitting tls still allows deliberate plaintext from actual HTTP bindings', () => {
  assert.deepEqual(
    connectionAddresses({ interfaces, httpBindings: boundHttp() }),
    connectionAddresses({ interfaces, httpBindings: boundHttp(), tls: off }),
  );
});

test('with TLS running the HTTPS addresses and TLS port are shown', () => {
  const result = connectionAddresses({ interfaces, plaintextPort: 4382, tls: on(4383) });
  assert.deepEqual(result.urls, [
    'https://192.168.1.5:4383',
    'https://10.0.0.7:4383',
    'https://127.0.0.1:4383',
  ]);
  assert.deepEqual(result.lan, ['https://192.168.1.5:4383', 'https://10.0.0.7:4383']);
  assert.equal(result.local, 'https://127.0.0.1:4383');
});

test('public-capable address lists do not advertise a diagnostics endpoint', () => {
  const plain = connectionAddresses({ interfaces, httpBindings: boundHttp(), tls: off });
  const secure = connectionAddresses({ interfaces, plaintextPort: 4382, tls: on(4383) });
  assert.equal('diagnostics' in plain, false);
  assert.equal('diagnostics' in secure, false);
});

test('the HTTPS default port 443 is omitted, any other port is kept', () => {
  const standard = connectionAddresses({ interfaces, plaintextPort: 4382, tls: on(443) });
  assert.deepEqual(standard.urls, ['https://192.168.1.5', 'https://10.0.0.7', 'https://127.0.0.1']);
  const other = connectionAddresses({ interfaces, plaintextPort: 4382, tls: on(8443) });
  assert.equal(other.local, 'https://127.0.0.1:8443');
});

test('port 80 is omitted for plaintext, but not port 443 and not 80 under https', () => {
  const plain = connectionAddresses({ interfaces, httpBindings: boundHttp(80), tls: off });
  assert.deepEqual(plain.urls, ['http://192.168.1.5', 'http://10.0.0.7', 'http://127.0.0.1']);
  assert.equal('diagnostics' in plain, false);
  assert.equal(
    connectionAddresses({ interfaces, httpBindings: boundHttp(443), tls: off }).local,
    'http://127.0.0.1:443',
  );
  assert.equal(
    connectionAddresses({ interfaces, plaintextPort: 4382, tls: on(80) }).local,
    'https://127.0.0.1:80',
  );
});

test('only actual bound HTTP ports are shown while TLS is inactive', () => {
  assert.equal(
    connectionAddresses({ interfaces, plaintextPort: 4382, tls: on(4383) }).local,
    'https://127.0.0.1:4383',
  );
  assert.equal(
    connectionAddresses({
      interfaces,
      plaintextPort: 9999,
      httpBindings: boundHttp(),
      tls: { active: false, port: 4383 },
    }).local,
    'http://127.0.0.1:4382',
  );
});

test('HTTP ignores unrelated link-local interfaces and reports only bound private LAN hosts', () => {
  const result = connectionAddresses({
    interfaces: () => ({
      A: [nic('127.0.0.1', { internal: true }), nic('::1', { family: 'IPv6', internal: true })],
      B: [nic('169.254.1.1', { internal: false }), nic('fe80::2', { family: 'IPv6' })],
      C: [nic('172.16.0.3')],
    }),
    plaintextPort: 4382,
    httpBindings: [
      { host: '172.16.0.3', port: 4382 },
      { host: '127.0.0.1', port: 4382 },
    ],
    tls: off,
  });
  assert.deepEqual(result.lan, ['http://172.16.0.3:4382']);
  assert.equal(result.urls.at(-1), 'http://127.0.0.1:4382');
});

test('a machine with no usable interface still offers the loopback preview', () => {
  const result = connectionAddresses({ interfaces: () => ({}), plaintextPort: 4382, tls: on() });
  assert.deepEqual(result.lan, []);
  assert.deepEqual(result.urls, ['https://127.0.0.1:4383']);
});

test('HTTPS interfaces are read on every call, so the answer can change', () => {
  let addresses = [nic('192.168.1.5')];
  const read = () => connectionAddresses({ interfaces: () => ({ e: addresses }), tls: on(4383) });
  assert.equal(read().lan[0], 'https://192.168.1.5:4383');
  addresses = [nic('10.1.1.1')];
  assert.equal(read().lan[0], 'https://10.1.1.1:4383');
});

test('the follow-up block lists the HTTPS addresses and a corrected warning', () => {
  const lines = secureAddressLines(
    connectionAddresses({ interfaces, plaintextPort: 4382, tls: on(4383) }),
  );
  const text = lines.join('\n');
  assert.match(text, /^\nVidVNC · Secure connection ready\n/);
  assert.match(text, /^Open https:\/\/192\.168\.1\.5:4383$/m);
  assert.match(text, /^Open https:\/\/10\.0\.0\.7:4383$/m);
  assert.match(text, /^Local preview: https:\/\/127\.0\.0\.1:4383$/m);
  assert.match(text, /^Live diagnostics \(this PC only\): use diagnostics open$/m);
  assert.match(
    text,
    /Devices that have not enrolled this PC's certificate will show a browser warning/,
  );
  assert.doesNotMatch(text, /http:\/\//);
  assert.doesNotMatch(text, /not encrypted/i);
  assert.doesNotMatch(text, /\/trust/i);
  assert.doesNotMatch(text, /Password/i);
  assert.doesNotMatch(text, /192\.168\.1\.5:4383\/diagnostics/);
});

test('the follow-up block omits Open lines when there is no LAN address', () => {
  const text = secureAddressLines(
    connectionAddresses({ interfaces: () => ({}), plaintextPort: 4382, tls: on(443) }),
  ).join('\n');
  assert.doesNotMatch(text, /^Open /m);
  assert.match(text, /^Local preview: https:\/\/127\.0\.0\.1$/m);
});

test('HTTPS follow-up says local HTTP is for trust only and omits a missing preview', () => {
  const lines = secureAddressLines({ lan: ['https://192.168.1.5:4383'], local: null });
  const text = lines.join('\n');
  assert.doesNotMatch(text, /Local preview: null/);
  assert.match(text, /local HTTP.*trust/i);
});

function fakeListener({ activates = true, rejects = false } = {}) {
  let active = false;
  let attempts = 0;
  return {
    get attempts() {
      return attempts;
    },
    status: () => ({ active, port: active ? 4383 : null }),
    async attempt() {
      attempts++;
      if (rejects) throw new Error('boom');
      if (activates) active = true;
    },
  };
}

test('an attempt that brings TLS up announces exactly once, later re-checks do not', async () => {
  const listener = fakeListener();
  const announced = [];
  const logged = [];
  const run = () =>
    attemptAndAnnounce({
      listener,
      announce: () => announced.push('up'),
      log: (message) => logged.push(message),
    });
  await run();
  await run();
  await run();
  assert.equal(listener.attempts, 3);
  assert.deepEqual(announced, ['up']);
  assert.deepEqual(logged, []);
});

test('an attempt that leaves TLS down announces nothing and prints nothing itself', async () => {
  const listener = fakeListener({ activates: false });
  const announced = [];
  const logged = [];
  await attemptAndAnnounce({
    listener,
    announce: () => announced.push('up'),
    log: (message) => logged.push(message),
  });
  assert.deepEqual(announced, []);
  assert.deepEqual(logged, []);
});

test('an attempt that rejects is logged, not announced, and does not throw', async () => {
  const announced = [];
  const logged = [];
  await attemptAndAnnounce({
    listener: fakeListener({ rejects: true }),
    announce: () => announced.push('up'),
    log: (message) => logged.push(message),
  });
  assert.deepEqual(announced, []);
  assert.deepEqual(logged, ['TLS attempt failed (boom).']);
});

test('a later attempt announces again after TLS went down and came back up', async () => {
  let active = false;
  const listener = {
    status: () => ({ active, port: active ? 4383 : null }),
    attempt: async () => {
      active = true;
    },
  };
  const announced = [];
  const run = () =>
    attemptAndAnnounce({ listener, announce: () => announced.push('up'), log: () => {} });
  await run();
  active = false; // the listener errored and dropped
  await run();
  assert.equal(announced.length, 2);
});

test('the info command shows the current plaintext rows exactly while TLS is down', async (t) => {
  const h = await liveConsole(t);
  const text = await h.send('info', /Diagnostics/);
  assert.match(text, /^Connect\s+http:\/\/192\.168\.1\.2:4382, http:\/\/127\.0\.0\.1:4382$/m);
  assert.match(text, /^Diagnostics\s+Use diagnostics open on this PC$/m);
});

test('the info command switches to the HTTPS rows when TLS comes up, evaluated at call time', async (t) => {
  const tls = { active: false, port: null };
  const h = await liveConsole(t, { tls });
  const before = await h.send('info', /Diagnostics/);
  assert.match(before, /^Connect\s+http:\/\/192\.168\.1\.2:4382, /m);
  tls.active = true;
  tls.port = 4383;
  const after = await h.send('info', /Diagnostics/);
  assert.match(after, /^Connect\s+https:\/\/192\.168\.1\.2:4383, https:\/\/127\.0\.0\.1:4383$/m);
  assert.match(after, /^Diagnostics\s+Use diagnostics open on this PC$/m);
});

test('the info command omits the port for HTTPS on 443', async (t) => {
  const h = await liveConsole(t, { tls: { active: true, port: 443 } });
  const text = await h.send('info', /Diagnostics/);
  assert.match(text, /^Connect\s+https:\/\/192\.168\.1\.2, https:\/\/127\.0\.0\.1$/m);
  assert.match(text, /^Diagnostics\s+Use diagnostics open on this PC$/m);
});
