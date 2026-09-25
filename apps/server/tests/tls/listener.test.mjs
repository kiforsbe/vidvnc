// Tests the TLS listener (src/tls/listener.mjs) and the plaintext allow-list/redirect in
// http-app.mjs. One test per row of the design's failure-handling table, plus the
// behaviour each of them protects.
//
// Nothing here calls the real ensureCertificate(): that would reach real mkcert and real
// Windows certificate tooling, exactly as Tasks 5 and 6 were caught doing. The certificate
// orchestration is injected as a fake in every test, and the fake is what decides which
// outcome the listener has to survive. The credentials it hands back are the committed
// `valid`/`expired` PEM fixtures, in the `{ cert, key }` shape the real strategies produce,
// so the TLS handshakes below are real ones, against a real `https.Server`, on loopback.
//
// Every server, socket and agent a test opens is released in `t.after`, never in a
// `finally` wrapped around the assertions and never after them: a failing assertion must
// not leave a listener running, because a leaked server keeps the test process alive and a
// red run would then hang instead of reporting its failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect as netConnect } from 'node:net';
import { request as httpRequest } from 'node:http';
import {
  Agent as HttpsAgent,
  createServer as createTlsServer,
  request as httpsRequest,
} from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { createHttpApp, PLAINTEXT_ALLOWED_PATHS } from '../../src/http-app.mjs';
import { createTlsListener } from '../../src/tls/listener.mjs';
import { defaultTlsSettings } from '../../src/tls/tls-settings.mjs';
import { SERVER_LIMITS } from '../../src/server-limits.mjs';

const fixture = (relativePath) =>
  fileURLToPath(new URL(`../fixtures/tls/${relativePath}`, import.meta.url));

const VALID = {
  cert: readFileSync(fixture('valid/cert.pem')),
  key: readFileSync(fixture('valid/key.pem')),
};
const EXPIRED = {
  cert: readFileSync(fixture('expired/cert.pem')),
  key: readFileSync(fixture('expired/key.pem')),
};
// A certificate and a key that each parse but do not belong together.
const MISMATCHED = { cert: VALID.cert, key: EXPIRED.key };
const validFingerprint = new X509Certificate(VALID.cert).fingerprint256;
const expiredFingerprint = new X509Certificate(EXPIRED.cert).fingerprint256;

// --- injected certificate orchestration ------------------------------------------------

// The report shape ensureCertificate() returns (ensure-certificate.mjs).
const ok = (credential, overrides = {}) => ({
  ok: true,
  attempted: true,
  strategy: 'mkcert',
  credential,
  anchor: null,
  warnings: [],
  reasons: [],
  reason: null,
  ...overrides,
});
const failed = (reason) => ({
  ok: false,
  attempted: true,
  strategy: null,
  credential: null,
  anchor: null,
  warnings: [],
  reasons: [],
  reason,
});

// A fake ensureCertificate that returns each queued outcome in turn (the last one repeats)
// and records every call, so a test can assert both what happened and how often.
function fakeEnsure(...outcomes) {
  const calls = [];
  const ensure = (settings) => {
    calls.push(settings);
    const next = outcomes.length > 1 ? outcomes.shift() : outcomes[0];
    if (next instanceof Error) throw next;
    return next;
  };
  ensure.calls = calls;
  return ensure;
}
const neverEnsure = () => {
  throw new Error('ensureCertificate must not be called in this test');
};

const settingsFor = (overrides = {}) => ({ ...defaultTlsSettings(), port: 0, ...overrides });

function collectLog() {
  const lines = [];
  const log = (message) => lines.push(message);
  log.lines = lines;
  return log;
}

// --- fixtures for a test's servers -----------------------------------------------------

// Builds a listener bound to an ephemeral loopback port around a real plaintext app, and
// arranges for it to be closed however the test ends. `ensureCertificate` is required: a
// forgotten one would silently fall through to the real default and reach real tooling.
// `created` records every https.Server the listener builds, so rotation tests can prove it
// never built a second one.
function makeListener(t, options) {
  assert.equal(
    typeof options?.ensureCertificate,
    'function',
    'makeListener needs an injected ensureCertificate',
  );
  const { ensureCertificate, settings = settingsFor(), createServer, host = '127.0.0.1' } = options;
  const log = options.log ?? collectLog();
  const created = [];
  const app = createHttpApp({ serverName: 'Test PC' });
  const listener = createTlsListener({
    settings,
    requestListener: app.requestListener,
    host,
    ensureCertificate,
    log,
    createServer:
      createServer ??
      ((credential, requestListener) => {
        const server = createTlsServer(credential, requestListener);
        created.push(server);
        return server;
      }),
  });
  t.after(() => listener.close());
  return { listener, log, created, app };
}

// A plaintext listener whose redirect decision comes from `tls` (a listener, or any object
// with the same `status()`), i.e. exactly how main.mjs wires the two together.
async function startPlaintext(t, tls, options = {}) {
  const server = createHttpApp({ serverName: 'Test PC', tls, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  const { port } = server.address();
  return { server, port, url: `http://127.0.0.1:${port}` };
}

// A bare https.Server that only occupies a port, for the port-in-use rows.
async function occupyPort(t) {
  const occupier = createTlsServer(VALID);
  await new Promise((resolve) => occupier.listen(0, '127.0.0.1', resolve));
  let released = false;
  const release = () => {
    if (released) return Promise.resolve();
    released = true;
    return new Promise((resolve) => occupier.close(resolve));
  };
  t.after(release);
  return { port: occupier.address().port, release };
}

// --- client helpers --------------------------------------------------------------------

function collect(response, resolve, extra = {}) {
  let body = '';
  response.on('data', (chunk) => (body += chunk));
  response.on('end', () =>
    resolve({ status: response.statusCode, headers: response.headers, body, ...extra }),
  );
}

// `rejectUnauthorized: false`: the fixtures are self-signed (one deliberately expired).
function httpsGet(port, path, { headers = {}, agent } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      { host: '127.0.0.1', port, path, method: 'GET', rejectUnauthorized: false, headers, agent },
      (response) => collect(response, resolve, { socket: response.socket }),
    );
    request.on('error', reject);
    request.end();
  });
}

// A plain-HTTP request with full control over the request target and Host header, which
// `fetch` does not allow.
function httpGet(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (response) =>
      collect(response, resolve),
    );
    request.on('error', reject);
    request.end();
  });
}

// Sends raw bytes and returns the status line and lower-cased header names of the reply, for
// request targets (`*`, absolute-form) that an HTTP client library will not emit.
function rawExchange(port, text) {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host: '127.0.0.1', port }, () => socket.write(text));
    let data = '';
    socket.on('data', (chunk) => (data += chunk));
    socket.on('error', reject);
    socket.on('close', () => {
      const [head] = data.split('\r\n\r\n');
      const [statusLine, ...headerLines] = head.split('\r\n');
      resolve({
        status: Number(statusLine.split(' ')[1]),
        headers: Object.fromEntries(
          headerLines.map((line) => {
            const at = line.indexOf(':');
            return [line.slice(0, at).toLowerCase(), line.slice(at + 1).trim()];
          }),
        ),
      });
    });
  });
}

// Connects and reports which leaf the listener presented, by SHA-256 fingerprint.
// `keepOpen` returns the live socket too, for tests about existing connections.
function connectTls(port, { keepOpen = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
      const fingerprint = socket.getPeerCertificate().fingerprint256;
      if (keepOpen) return resolve({ fingerprint, socket });
      socket.end();
      resolve({ fingerprint });
    });
    socket.on('error', reject);
  });
}

// --- the allow-list --------------------------------------------------------------------

// The enrolment page plus exactly what it loads, spelled out here so widening the list is a
// visible change to this file; trust-page.test.mjs separately proves the list matches the page.
test('the plaintext allow-list is exactly the enrolment page, its assets and the two endpoints', () => {
  assert.deepEqual(
    [...PLAINTEXT_ALLOWED_PATHS].sort(),
    [
      '/api/trust/anchor',
      '/api/trust/status',
      '/shell.css',
      '/style.css',
      '/theme.js',
      '/trust',
      '/trust-instructions.js',
      '/trust-model.js',
      '/trust.css',
      '/trust.js',
    ].sort(),
  );
});

// --- serving and redirecting -----------------------------------------------------------

test('a TLS request to the secure port is served, over a real handshake against the fixture credential', async (t) => {
  const { listener, log } = makeListener(t, { ensureCertificate: fakeEnsure(ok(VALID)) });
  await listener.attempt();
  const { active, port } = listener.status();
  assert.equal(active, true);

  const { status, body } = await httpsGet(port, '/api/info');
  assert.equal(status, 200);
  assert.deepEqual(JSON.parse(body), { publicName: 'VidVNC host' });
  assert.equal((await connectTls(port)).fingerprint, validFingerprint);
  assert.match(log.lines.join('\n'), /TLS ready on port \d+ \(strategy: mkcert\)/);
});

test('a plaintext request to a non-enrolment path redirects to the HTTPS equivalent, preserving path and query', async (t) => {
  const { listener } = makeListener(t, { ensureCertificate: fakeEnsure(ok(VALID)) });
  await listener.attempt();
  const { port } = listener.status();
  const plaintext = await startPlaintext(t, listener);

  const response = await fetch(plaintext.url + '/api/info?display=1&x=%20y', {
    redirect: 'manual',
  });
  assert.equal(response.status, 307);
  assert.equal(
    response.headers.get('location'),
    `https://127.0.0.1:${port}/api/info?display=1&x=%20y`,
  );
  // The redirect target really is serving.
  assert.equal((await httpsGet(port, '/api/info?display=1')).status, 200);
});

test('the redirect is 307 with no-store, never a cacheable 308, so a stale redirect cannot outlive TLS', async (t) => {
  const plaintext = await startPlaintext(t, { status: () => ({ active: true, port: 8443 }) });
  const response = await fetch(plaintext.url + '/api/info', { redirect: 'manual' });

  assert.equal(response.status, 307);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.notEqual(response.status, 308);
  assert.notEqual(response.status, 301);
});

test('a plaintext POST also redirects, 307 preserving the method for a mid-session client', async (t) => {
  const plaintext = await startPlaintext(t, { status: () => ({ active: true, port: 8443 }) });
  const response = await fetch(plaintext.url + '/api/heartbeat', {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('location'), 'https://127.0.0.1:8443/api/heartbeat');
});

// What each enrolment path answers is anchor-endpoint.test.mjs's business (Task 11) and
// /trust's is trust-page.test.mjs's; this test only pins that none of them is redirected.
test('a plaintext request to an enrolment path is served without redirect', async (t) => {
  const plaintext = await startPlaintext(t, { status: () => ({ active: true, port: 8443 }) });
  for (const path of PLAINTEXT_ALLOWED_PATHS) {
    const response = await fetch(plaintext.url + path, { redirect: 'manual' });
    assert.notEqual(response.status, 307, path);
    assert.equal(response.headers.get('location'), null, path);
  }
  assert.equal((await fetch(plaintext.url + '/trust', { redirect: 'manual' })).status, 200);
});

test('a request that arrived over TLS is never redirected, even to an enrolment path', async (t) => {
  const { listener } = makeListener(t, { ensureCertificate: fakeEnsure(ok(VALID)) });
  // The shared handler is handed the listener's own status, so this is the path a real
  // HTTPS request takes through the redirect check.
  const app = createHttpApp({ serverName: 'Test PC', tls: listener });
  const secure = createTlsServer(VALID, app.requestListener);
  await new Promise((resolve) => secure.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        secure.close(resolve);
        secure.closeAllConnections();
      }),
  );
  await listener.attempt();
  const port = secure.address().port;
  for (const path of ['/api/info', '/trust']) {
    const response = await httpsGet(port, path);
    assert.notEqual(response.status, 307, path);
    assert.equal(response.headers.location, undefined, path);
  }
});

test('a hostile Host header is refused with 403 and no Location, even while TLS is active: the redirect runs after the host allow-list', async (t) => {
  const plaintext = await startPlaintext(t, { status: () => ({ active: true, port: 8443 }) });
  const hostile = [
    'evil.example',
    'evil.example:8443',
    '127.0.0.1.evil.example',
    '127.0.0.1@evil.example',
    'evil.example#127.0.0.1',
    'localhost.evil.example',
  ];
  for (const host of hostile) {
    const response = await httpGet(plaintext.port, '/api/info', { headers: { host } });
    assert.equal(response.status, 403, host);
    assert.equal(response.headers.location, undefined, host);
  }
  // Control: the same request with an allow-listed Host is what redirects.
  const legit = await httpGet(plaintext.port, '/api/info', {
    headers: { host: `127.0.0.1:${plaintext.port}` },
  });
  assert.equal(legit.status, 307);
  assert.equal(legit.headers.location, 'https://127.0.0.1:8443/api/info');
});

test('a matching absolute-form POST redirects without dispatching the key API', async (t) => {
  const plaintext = await startPlaintext(t, { status: () => ({ active: true, port: 8443 }) });
  const response = await rawExchange(
    plaintext.port,
    `POST http://127.0.0.1:${plaintext.port}/api/key-start?x=1 HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${plaintext.port}\r\nContent-Type: application/json\r\n` +
      'Content-Length: 2\r\nConnection: close\r\n\r\n{}',
  );
  assert.equal(response.status, 307);
  assert.equal(response.headers.location, 'https://127.0.0.1:8443/api/key-start?x=1');
});

test('unsupported or mismatched request targets never dispatch a plaintext API', async (t) => {
  const plaintext = await startPlaintext(t, { status: () => ({ active: true, port: 8443 }) });
  const targets = [
    'OPTIONS *',
    'POST http://evil.example/api/key-start',
    `POST https://127.0.0.1:${plaintext.port}/api/key-start`,
    `POST http://127.0.0.1:9999/api/key-start`,
  ];
  for (const line of targets) {
    const response = await rawExchange(
      plaintext.port,
      `${line} HTTP/1.1\r\nHost: 127.0.0.1:${plaintext.port}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`,
    );
    assert.ok([400, 421].includes(response.status), `${line}: ${response.status}`);
    assert.equal(response.headers.location, undefined, line);
  }
});

// --- the Origin guard, through a real TLS connection -----------------------------------

test('a real Origin header over a real TLS connection is judged against https and the port it arrived on', async (t) => {
  const { listener } = makeListener(t, { ensureCertificate: fakeEnsure(ok(VALID)) });
  await listener.attempt();
  const { port } = listener.status();
  // One keep-alive socket for every request, so the schemes are compared on the SAME
  // connection: the scheme must come from the socket, not from anything the request says.
  const agent = new HttpsAgent({ keepAlive: true, maxSockets: 1, rejectUnauthorized: false });
  t.after(() => agent.destroy());
  const get = (origin) => httpsGet(port, '/api/info', { agent, headers: { origin } });

  const same = await get(`https://127.0.0.1:${port}`);
  assert.equal(same.status, 200, 'the HTTPS origin of this very listener is accepted');

  const downgraded = await get(`http://127.0.0.1:${port}`);
  assert.equal(downgraded.status, 403, 'an http:// origin on a TLS connection is cross-origin');
  assert.equal(downgraded.socket, same.socket, 'both requests used the same TLS socket');

  assert.equal((await get(`https://127.0.0.1:${port + 1}`)).status, 403);
  assert.equal((await get('https://evil.example')).status, 403);
  assert.equal((await get(`https://127.0.0.1:${port}`)).status, 200);
});

test('a real TLS connection rejects a Host claiming port 443 when the socket is on another port', async (t) => {
  const { listener } = makeListener(t, { ensureCertificate: fakeEnsure(ok(VALID)) });
  await listener.attempt();
  const { port } = listener.status();
  // The Origin unit tests cover default-port normalization. This socket is not on 443,
  // so a Host that claims 443 must be rejected before Origin is considered.
  const get = (origin) => httpsGet(port, '/api/info', { headers: { host: '127.0.0.1', origin } });

  assert.equal((await get('https://127.0.0.1')).status, 421);
  assert.equal((await get('https://127.0.0.1:443')).status, 421);
  assert.equal((await get(`https://127.0.0.1:${port}`)).status, 421);
  assert.equal((await get('http://127.0.0.1')).status, 421);
});

// --- failure table: no strategy succeeds -----------------------------------------------

test('no strategy succeeds in auto: HTTP viewer fails closed while trust remains local', async (t) => {
  const { listener, log } = makeListener(t, {
    ensureCertificate: fakeEnsure(
      failed('mkcert: mkcert is not available; windows-self-signed: PowerShell unavailable'),
    ),
    createServer: () => assert.fail('no TLS server may be built without a credential'),
  });
  await listener.attempt();
  assert.deepEqual(listener.status(), { active: false, port: null });
  assert.match(log.lines.join('\n'), /TLS unavailable/);
  assert.match(log.lines.join('\n'), /mkcert is not available/);
  assert.match(log.lines.join('\n'), /PowerShell unavailable/);
  assert.match(log.lines.join('\n'), /HTTP viewer.*disabled/);

  const plaintext = await startPlaintext(t, listener);
  for (const path of ['/', '/api/info']) {
    const response = await fetch(plaintext.url + path, { redirect: 'manual' });
    assert.equal(response.status, 503, path);
    assert.equal(response.headers.get('cache-control'), 'no-store', path);
  }
  for (const path of PLAINTEXT_ALLOWED_PATHS) {
    const response = await fetch(plaintext.url + path, { redirect: 'manual' });
    assert.notEqual(response.status, 307, path);
  }
});

test('an ensureCertificate that throws is survived, logged, and leaves plaintext serving', async (t) => {
  const { listener, log } = makeListener(t, {
    ensureCertificate: fakeEnsure(new Error('unexpected explosion')),
  });
  await assert.doesNotReject(listener.attempt());
  assert.equal(listener.status().active, false);
  assert.match(log.lines.join('\n'), /unexpected explosion/);
});

test('an attempt that fails in a way nothing anticipated still resolves: attempt() never rejects, so a fire-and-forget caller cannot crash the process', async (t) => {
  // A malformed report (no object at all) makes run() itself throw, outside every
  // anticipated failure path.
  const { listener, log } = makeListener(t, { ensureCertificate: () => undefined });
  await assert.doesNotReject(listener.attempt());
  assert.equal(listener.status().active, false);
  assert.match(log.lines.join('\n'), /TLS attempt failed unexpectedly/);
  // ...and the listener is still usable afterwards.
  await assert.doesNotReject(listener.attempt());
});

test('mode off consults nothing, binds nothing and logs nothing', async (t) => {
  const { listener, log } = makeListener(t, {
    settings: settingsFor({ mode: 'off' }),
    ensureCertificate: neverEnsure,
    createServer: () => assert.fail('mode off must never build a TLS server'),
  });
  await listener.attempt();
  assert.deepEqual(listener.status(), { active: false, port: null });
  assert.deepEqual(log.lines, []);
  const plaintext = await startPlaintext(t, listener, { plaintextMode: 'lan-http' });
  const response = await fetch(plaintext.url + '/api/info', { redirect: 'manual' });
  assert.equal(response.status, 200);
});

// --- failure table: provided certificate fails -----------------------------------------

test('a failing provided certificate is reported as a configuration error, and nothing is generated in its place', async (t) => {
  const ensure = fakeEnsure(
    failed('provided: certificate "C:\\certs\\host.pem" has expired (valid until 2025-01-01)'),
  );
  const { listener, log } = makeListener(t, {
    settings: settingsFor({
      mode: 'provided',
      certificatePath: 'C:\\certs\\host.pem',
      keyPath: 'C:\\certs\\host.key',
    }),
    ensureCertificate: ensure,
    createServer: () => assert.fail('no TLS server may be built from a failed credential'),
  });
  await listener.attempt();
  assert.equal(listener.status().active, false);
  const text = log.lines.join('\n');
  assert.match(text, /TLS configuration error/);
  assert.match(text, /has expired/);
  assert.match(text, /no certificate was generated in its place/);
  // The listener asked for a credential exactly once, in the operator's own mode, and
  // never retried with anything else.
  assert.equal(ensure.calls.length, 1);
  assert.equal(ensure.calls[0].mode, 'provided');

  const plaintext = await startPlaintext(t, listener);
  const response = await fetch(plaintext.url + '/api/info', { redirect: 'manual' });
  assert.equal(response.status, 503);
});

// --- failure table: a credential the TLS stack rejects on the FIRST bind ---------------

// The timeout turns a regression (a rejection nobody handles, or an attempt that never
// settles) into a fast, named failure instead of a hung run.
for (const [label, credential] of [
  ['a certificate and key that do not belong together', MISMATCHED],
  ['unparseable garbage', { cert: 'not a certificate', key: 'not a key' }],
]) {
  test(
    `${label} on the very first bind leaves the process alive but HTTP viewer unavailable`,
    { timeout: 5000 },
    async (t) => {
      // The real createServer, exactly as main.mjs uses it: this is the call that throws
      // synchronously for such a credential, and that used to reject the whole attempt
      // and, through a fire-and-forget caller, crash the server.
      const { listener, log, created } = makeListener(t, {
        ensureCertificate: fakeEnsure(ok(credential)),
      });
      await assert.doesNotReject(listener.attempt());

      assert.deepEqual(listener.status(), { active: false, port: null });
      assert.equal(created.length, 0, 'no server was left behind');
      const text = log.lines.join('\n');
      assert.match(text, /TLS configuration error \(/);
      assert.match(text, /HTTP viewer.*disabled/);

      // Trust remains available, but the viewer cannot fall back to plaintext.
      const plaintext = await startPlaintext(t, listener);
      const response = await fetch(plaintext.url + '/api/info', { redirect: 'manual' });
      assert.equal(response.status, 503);
      assert.equal((await fetch(plaintext.url + '/trust')).status, 200);
    },
  );
}

test('a mismatched pair names the OpenSSL cause, so the operator can act on the log line', async (t) => {
  const { listener, log } = makeListener(t, { ensureCertificate: fakeEnsure(ok(MISMATCHED)) });
  await listener.attempt();
  assert.match(log.lines.join('\n'), /key values mismatch/i);
});

test(
  'an unbindable port (listen throws synchronously) is survived and logged, not thrown',
  { timeout: 5000 },
  async (t) => {
    const { listener, log } = makeListener(t, {
      settings: settingsFor({ port: 70000 }), // out of range: listen() throws, not an 'error' event
      ensureCertificate: fakeEnsure(ok(VALID)),
    });
    await assert.doesNotReject(listener.attempt());
    assert.equal(listener.status().active, false);
    assert.match(log.lines.join('\n'), /TLS listener error on port 70000/);
  },
);

// --- failure table: TLS port already in use --------------------------------------------

test(
  'a TLS port already in use leaves the process alive but not the HTTP viewer',
  { timeout: 5000 },
  async (t) => {
    const { port } = await occupyPort(t);
    const { listener, log } = makeListener(t, {
      settings: settingsFor({ port }),
      ensureCertificate: fakeEnsure(ok(VALID)),
    });
    // If the bind failure became an unhandled 'error' event this would take the whole test
    // process down rather than resolve.
    await assert.doesNotReject(listener.attempt());

    assert.equal(listener.status().active, false);
    const text = log.lines.join('\n');
    assert.match(text, new RegExp(`TLS port ${port} is already in use`));
    assert.match(text, /HTTP viewer.*disabled/);

    // Because TLS is not actually up, plaintext must neither redirect nor admit a viewer.
    const plaintext = await startPlaintext(t, listener);
    const response = await fetch(plaintext.url + '/api/info', { redirect: 'manual' });
    assert.equal(response.status, 503);
  },
);

test(
  'once the port is freed, the periodic re-check brings TLS up without a restart',
  { timeout: 5000 },
  async (t) => {
    const { port, release } = await occupyPort(t);
    const { listener } = makeListener(t, {
      settings: settingsFor({ port }),
      ensureCertificate: fakeEnsure(ok(VALID)),
    });
    await listener.attempt();
    assert.equal(listener.status().active, false);

    await release();
    await listener.attempt();

    assert.deepEqual(listener.status(), { active: true, port });
    assert.equal((await connectTls(port)).fingerprint, validFingerprint);
  },
);

// --- hardening parity with the plaintext listener --------------------------------------

test('the TLS server carries the same connection limits as the plaintext server, not Node defaults', async (t) => {
  const { listener, created, app } = makeListener(t, {
    ensureCertificate: fakeEnsure(ok(VALID)),
  });
  await listener.attempt();
  assert.equal(created.length, 1);
  const [secure] = created;

  // The literal values, so lowering or dropping one is a visible change to this test...
  assert.equal(secure.requestTimeout, 15000);
  assert.equal(secure.headersTimeout, 10000);
  assert.equal(secure.maxConnections, 32);
  assert.deepEqual(SERVER_LIMITS, {
    requestTimeout: 15000,
    headersTimeout: 10000,
    maxConnections: 32,
    maxConnectionsPerSource: 12,
  });
  // ...and parity with what the plaintext server actually carries, so the two cannot drift.
  assert.equal(secure.requestTimeout, app.requestTimeout);
  assert.equal(secure.headersTimeout, app.headersTimeout);
  assert.equal(secure.maxConnections, app.maxConnections);
});

// --- failure table: certificate expires while running ----------------------------------

test('rotation swaps the credential in place, never closing or rebuilding the listener, and a connection made after rotation sees the new certificate', async (t) => {
  const { listener, created } = makeListener(t, {
    ensureCertificate: fakeEnsure(ok(VALID), ok(EXPIRED, { strategy: 'windows-self-signed' })),
  });
  await listener.attempt();
  const { port } = listener.status();
  assert.equal(created.length, 1);
  let closed = false;
  created[0].once('close', () => (closed = true));

  // A connection made before rotation, held open across it.
  const before = await connectTls(port, { keepOpen: true });
  t.after(() => before.socket.destroy());
  assert.equal(before.fingerprint, validFingerprint);

  await listener.attempt(); // the periodic re-check finds a replacement credential

  const after = await connectTls(port);
  assert.equal(after.fingerprint, expiredFingerprint);
  assert.notEqual(after.fingerprint, before.fingerprint);

  // The same listener throughout: one server ever built, same port, never closed, still
  // listening, and the connection opened before rotation was not dropped.
  assert.equal(created.length, 1);
  assert.deepEqual(listener.status(), { active: true, port });
  assert.equal(created[0].listening, true);
  assert.equal(closed, false);
  assert.equal(before.socket.destroyed, false);

  // The shared request handler still answers after rotation.
  assert.equal((await httpsGet(port, '/api/info')).status, 200);
});

test('a re-check that returns the same credential keeps serving it from the same server', async (t) => {
  const { listener, created } = makeListener(t, {
    ensureCertificate: fakeEnsure(ok(VALID), ok(VALID)),
  });
  await listener.attempt();
  const { port } = listener.status();

  await listener.attempt();

  assert.equal((await connectTls(port)).fingerprint, validFingerprint);
  assert.equal(created.length, 1);
  assert.deepEqual(listener.status(), { active: true, port });
});

test('a failed re-check keeps serving the current certificate and says so', async (t) => {
  const { listener, log, created } = makeListener(t, {
    ensureCertificate: fakeEnsure(ok(VALID), failed('mkcert: mkcert -CAROOT exited 1')),
  });
  await listener.attempt();
  const { port } = listener.status();

  await listener.attempt();

  assert.equal((await connectTls(port)).fingerprint, validFingerprint);
  assert.equal(listener.status().active, true);
  assert.equal(created.length, 1);
  assert.match(log.lines.join('\n'), /TLS re-check failed \(mkcert: mkcert -CAROOT exited 1\)/);
  assert.match(log.lines.join('\n'), /Continuing with the current certificate/);
});

test('a credential that cannot be loaded during rotation is reported and the old certificate keeps serving', async (t) => {
  const { listener, log } = makeListener(t, {
    ensureCertificate: fakeEnsure(ok(VALID), ok({ cert: 'not a certificate', key: 'not a key' })),
  });
  await listener.attempt();
  const { port } = listener.status();

  await assert.doesNotReject(listener.attempt());

  assert.match(log.lines.join('\n'), /TLS certificate rotation failed/);
  assert.equal(listener.status().active, true);
  assert.equal((await connectTls(port)).fingerprint, validFingerprint);
});

// --- lifecycle -------------------------------------------------------------------------

test('overlapping attempts join one provisioning call rather than racing it', async (t) => {
  const ensure = fakeEnsure(ok(VALID));
  const { listener, created } = makeListener(t, { ensureCertificate: ensure });
  await Promise.all([listener.attempt(), listener.attempt(), listener.attempt()]);
  assert.equal(ensure.calls.length, 1);
  assert.equal(created.length, 1);
  assert.equal(listener.status().active, true);
});

test('warnings from provisioning are surfaced in the log when TLS comes up', async (t) => {
  const { listener, log } = makeListener(t, {
    ensureCertificate: fakeEnsure(
      ok(VALID, {
        strategy: 'provided',
        warnings: [
          'certificate "host.pem" does not cover this machine\'s current address(es): Thor',
        ],
      }),
    ),
  });
  await listener.attempt();
  assert.match(log.lines.join('\n'), /does not cover this machine's current address/);
});

test('close() stops the TLS listener, reports inactive, and later attempts do nothing', async (t) => {
  const { listener } = makeListener(t, { ensureCertificate: fakeEnsure(ok(VALID)) });
  await listener.attempt();
  const { port } = listener.status();

  await listener.close();
  assert.deepEqual(listener.status(), { active: false, port: null });
  await assert.rejects(connectTls(port), { code: 'ECONNREFUSED' });

  await listener.attempt();
  assert.equal(listener.status().active, false);
});

test('makeListener refuses to run without an injected ensureCertificate', (t) => {
  assert.throws(() => makeListener(t, {}), /needs an injected ensureCertificate/);
});

// --- forced reissue (Task 14's host UI regenerate action) --------------------------------

// Like `fakeEnsure`, but records the `deps` each call received rather than the settings, so
// these tests read `force` at the boundary the listener actually controls.
function forceRecordingEnsure(...outcomes) {
  const forced = [];
  const ensure = (settings, deps = {}) => {
    forced.push(deps.force);
    const next = outcomes.length > 1 ? outcomes.shift() : outcomes[0];
    if (next instanceof Error) throw next;
    return next;
  };
  ensure.forced = forced;
  return ensure;
}

test('an ordinary attempt asks for no reissue; attempt({ force: true }) does', async (t) => {
  const ensureCertificate = forceRecordingEnsure(ok(VALID));
  const { listener } = makeListener(t, { ensureCertificate });
  await listener.attempt();
  await listener.attempt({ force: true });
  await listener.attempt({ force: false });
  assert.deepEqual(ensureCertificate.forced, [false, true, false]);
});

test('a forced attempt rotates the running listener in place rather than rebuilding it', async (t) => {
  const ensureCertificate = forceRecordingEnsure(ok(VALID), ok(VALID, { strategy: 'mkcert' }));
  const { listener, created } = makeListener(t, { ensureCertificate });
  await listener.attempt();
  const boundPort = listener.status().port;
  await listener.attempt({ force: true });
  assert.equal(created.length, 1, 'a regenerate must not build a second https.Server');
  assert.deepEqual(listener.status(), { active: true, port: boundPort });
  assert.equal(listener.report().active, false); // no anchor in these fakes, per `ok()`
  assert.deepEqual(ensureCertificate.forced, [false, true]);
});

test('provided mode never forces: an operator certificate is not regenerated on request', async (t) => {
  const ensureCertificate = forceRecordingEnsure(ok(VALID));
  const { listener } = makeListener(t, {
    ensureCertificate,
    settings: settingsFor({ mode: 'provided' }),
  });
  await listener.attempt({ force: true });
  assert.deepEqual(ensureCertificate.forced, [false]);
});

test('mode off never forces, and never provisions anything at all', async (t) => {
  const { listener, log } = makeListener(t, {
    ensureCertificate: neverEnsure,
    settings: settingsFor({ mode: 'off' }),
  });
  await listener.attempt({ force: true });
  assert.deepEqual(listener.status(), { active: false, port: null });
  assert.deepEqual(log.lines, []);
});

test('a forced attempt queues behind an in-flight ordinary one instead of joining it', async (t) => {
  const ensureCertificate = forceRecordingEnsure(ok(VALID));
  const { listener } = makeListener(t, { ensureCertificate });
  // Not awaited: the ordinary attempt is still binding when the forced one arrives. Joining
  // it would return having reused the existing credential, reporting a regeneration that
  // never happened.
  const ordinary = listener.attempt();
  const regenerate = listener.attempt({ force: true });
  assert.notEqual(ordinary, regenerate);
  await Promise.all([ordinary, regenerate]);
  assert.deepEqual(ensureCertificate.forced, [false, true]);
  assert.equal(listener.status().active, true);
});

test('two ordinary concurrent attempts still join rather than provisioning twice', async (t) => {
  const ensureCertificate = forceRecordingEnsure(ok(VALID));
  const { listener } = makeListener(t, { ensureCertificate });
  const first = listener.attempt();
  const second = listener.attempt();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.deepEqual(ensureCertificate.forced, [false]);
});

test('a forced attempt that fails leaves the existing certificate serving and never rejects', async (t) => {
  const ensureCertificate = forceRecordingEnsure(ok(VALID), failed('regeneration went wrong'));
  const { listener, log } = makeListener(t, { ensureCertificate });
  await listener.attempt();
  const boundPort = listener.status().port;
  await listener.attempt({ force: true });
  assert.deepEqual(listener.status(), { active: true, port: boundPort });
  assert.equal(listener.report().failureReason, 'regeneration went wrong');
  assert.ok(log.lines.some((line) => line.includes('Continuing with the current certificate')));
});
