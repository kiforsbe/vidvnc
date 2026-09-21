// Tests the enrolment endpoints (GET /api/trust/anchor and GET /api/trust/status in
// http-app.mjs) and the `report()` the TLS listener retains for them (tls/listener.mjs).
//
// Two layers, so each failure points at one cause:
//   1. the endpoints, against a real `createHttpApp` and real HTTP requests, but with a
//      stubbed `tls` object exposing `status()`/`report()` — no provisioning of any kind;
//   2. the listener's retained report, and both endpoints end to end over a real TLS
//      listener, with an injected `ensureCertificate` handing back the committed
//      test-only fixtures. Nothing here reaches real mkcert or Windows certificate tooling.
//
// Every server started here binds an ephemeral loopback port (never 4382/4383, which the
// user's own VidVNC may hold) and is stopped in `t.after`, not in a `finally` around the
// assertions, so a failing assertion cannot leave a listener running.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { createServer as createTlsServer, request as httpsRequest } from 'node:https';
import { createHttpApp, PLAINTEXT_ALLOWED_PATHS } from '../../src/http-app.mjs';
import { createTlsListener } from '../../src/tls/listener.mjs';
import { defaultTlsSettings } from '../../src/tls/tls-settings.mjs';
import {
  anchorReport,
  ENROLMENT_NOT_REQUIRED,
  ENROLMENT_REQUIRED,
  ENROLMENT_UNKNOWN,
} from '../../src/tls/anchor.mjs';

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
const validAnchor = new X509Certificate(VALID.cert);
const expiredAnchor = new X509Certificate(EXPIRED.cert);

const ANCHOR_PATH = '/api/trust/anchor';
const STATUS_PATH = '/api/trust/status';

// The exact download name; iOS/Android/Windows decide what to offer from it and the type.
const FILENAME_HEADER = 'attachment; filename="VidVNC-trust.crt"';

// --- reports the endpoints are handed --------------------------------------------------

// A self-signed anchor, as `windows-self-signed` and mkcert (its CA root) both produce.
const requiredReport = (overrides = {}) => ({
  ...anchorReport({ ok: true, strategy: 'mkcert', anchor: validAnchor }),
  failureReason: null,
  ...overrides,
});
// A `provided`-mode certificate chained to something else (anchor.mjs: ENROLMENT_UNKNOWN).
// A plain object stands in for the X509Certificate: anchorReport reads only
// issuer/subject/fingerprint256.
const unknownReport = () => ({
  ...anchorReport({
    ok: true,
    strategy: 'provided',
    anchor: {
      issuer: 'CN=Example Root CA',
      subject: 'CN=vidvnc.example.com',
      fingerprint256: 'DE:AD:BE:EF:00:11:22:33',
    },
  }),
  failureReason: null,
});
// Not reachable from anchorReport() with today's three strategies (see anchor.mjs), so it
// is built by hand: the endpoint must still refuse to serve a file for it.
const notRequiredReport = () => ({
  active: true,
  enrolmentStatus: ENROLMENT_NOT_REQUIRED,
  strategy: 'provided',
  anchor: validAnchor,
  fingerprint: validAnchor.fingerprint256,
  failureReason: null,
});
const inactiveReport = (failureReason = null) => ({ ...anchorReport(null), failureReason });

// What the app is given as its `tls` option in the endpoint tests.
function stubTls(report, status) {
  const live = status ?? { active: report.active, port: report.active ? 8443 : null };
  return { status: () => live, report: () => report };
}

// --- helpers ---------------------------------------------------------------------------

async function startApp(t, options = {}) {
  const server = createHttpApp({ serverName: 'Test PC', ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  return { server, port: server.address().port };
}

function collect(response, resolve) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => {
    const bytes = Buffer.concat(chunks);
    resolve({
      status: response.statusCode,
      headers: response.headers,
      bytes,
      text: bytes.toString('utf8'),
    });
  });
}

// Plain HTTP with full control over method and headers (Host, Origin), which fetch forbids.
function httpCall(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method, headers }, (response) =>
      collect(response, resolve),
    );
    request.on('error', reject);
    request.end();
  });
}

// `rejectUnauthorized: false`: the fixtures are self-signed.
function httpsCall(port, path, { method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      { host: '127.0.0.1', port, path, method, rejectUnauthorized: false },
      (response) => collect(response, resolve),
    );
    request.on('error', reject);
    request.end();
  });
}

const json = (response) => JSON.parse(response.text);

// Node's own format for fingerprint256 (uppercase, colon-separated), derived independently
// from raw bytes, so a served file can be compared with what the status endpoint reports.
const sha256Colon = (bytes) =>
  createHash('sha256').update(bytes).digest('hex').toUpperCase().match(/.{2}/g).join(':');

// --- the anchor download ---------------------------------------------------------------

test('the anchor is served as DER with the type and filename devices recognise, uncached and unsniffable', async (t) => {
  const { port } = await startApp(t, { tls: stubTls(requiredReport()) });
  const response = await httpCall(port, ANCHOR_PATH);

  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'application/x-x509-ca-cert');
  assert.equal(response.headers['content-disposition'], FILENAME_HEADER);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['content-length'], String(validAnchor.raw.length));
  assert.ok(response.bytes.length > 0, 'never an empty file');
  assert.deepEqual(response.bytes, validAnchor.raw);
});

test('the fingerprint the status endpoint reports is the SHA-256 of the bytes the download serves', async (t) => {
  const { port } = await startApp(t, { tls: stubTls(requiredReport()) });
  const file = await httpCall(port, ANCHOR_PATH);
  const status = json(await httpCall(port, STATUS_PATH));

  assert.equal(sha256Colon(file.bytes), status.fingerprint);
  assert.equal(status.fingerprint, validAnchor.fingerprint256);
});

test('the served bytes and the status JSON never carry key material', async (t) => {
  const { port } = await startApp(t, { tls: stubTls(requiredReport()) });
  const file = await httpCall(port, ANCHOR_PATH);
  const status = await httpCall(port, STATUS_PATH);

  // The fixture key exists on disk next to the fixture certificate; nothing served may
  // contain it, in PEM or DER form.
  const keyDer = Buffer.from(
    VALID.key
      .toString('utf8')
      .replace(/-----[^-]+-----/g, '')
      .replace(/\s+/g, ''),
    'base64',
  );
  assert.ok(keyDer.length > 100, 'the fixture key was actually loaded');
  for (const served of [file.bytes, status.bytes]) {
    assert.equal(served.includes('PRIVATE KEY'), false);
    assert.equal(served.includes('BEGIN'), false);
    assert.equal(served.includes(keyDer), false);
  }
});

test('an anchor that needs no enrolment answers with a JSON reason and no file', async (t) => {
  const { port } = await startApp(t, { tls: stubTls(notRequiredReport()) });
  const response = await httpCall(port, ANCHOR_PATH);

  assert.equal(response.status, 404);
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.equal(response.headers['content-disposition'], undefined);
  const body = json(response);
  assert.equal(body.enrolmentStatus, ENROLMENT_NOT_REQUIRED);
  assert.match(body.error, /nothing to install/i);
  assert.equal(response.text.includes('BEGIN'), false);
});

test('an operator-supplied certificate whose issuer is unknown is not offered as a download, and the answer says why', async (t) => {
  // The design's `provided` row: do not offer a chain nobody should install.
  const { port } = await startApp(t, { tls: stubTls(unknownReport()) });
  const response = await httpCall(port, ANCHOR_PATH);

  assert.equal(response.status, 404);
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.equal(response.headers['content-disposition'], undefined);
  const body = json(response);
  assert.equal(body.enrolmentStatus, ENROLMENT_UNKNOWN);
  assert.match(body.error, /supplied/i);
  assert.match(body.error, /administrator|issuer/i);
});

test('with no credential the endpoint says so with 503 and JSON, never an empty file with 200', async (t) => {
  const { port } = await startApp(t, { tls: stubTls(inactiveReport()) });
  const response = await httpCall(port, ANCHOR_PATH);

  assert.equal(response.status, 503);
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.equal(response.headers['content-disposition'], undefined);
  assert.equal(response.headers['cache-control'], 'no-store');
  const body = json(response);
  assert.equal(body.enrolmentStatus, null);
  assert.match(body.error, /HTTPS is not running/i);
});

test('an app given no tls option at all, or a tls object without report(), behaves as TLS-inactive', async (t) => {
  const bare = await startApp(t);
  const legacy = await startApp(t, { tls: { status: () => ({ active: false, port: null }) } });
  for (const { port } of [bare, legacy]) {
    const anchor = await httpCall(port, ANCHOR_PATH);
    assert.equal(anchor.status, 503);
    assert.equal(json(anchor).enrolmentStatus, null);
    const status = json(await httpCall(port, STATUS_PATH));
    assert.equal(status.active, false);
    assert.equal(status.enrolmentStatus, null);
  }
});

// --- the status endpoint ---------------------------------------------------------------

test('status while enrolment is required: state, strategy, fingerprint, a message and the download path', async (t) => {
  const { port } = await startApp(t, { tls: stubTls(requiredReport()) });
  const response = await httpCall(port, STATUS_PATH);

  assert.equal(response.status, 200);
  assert.match(response.headers['content-type'], /^application\/json/);
  assert.equal(response.headers['cache-control'], 'no-store');
  const body = json(response);
  assert.deepEqual(body, {
    active: true,
    enrolmentStatus: ENROLMENT_REQUIRED,
    strategy: 'mkcert',
    fingerprint: validAnchor.fingerprint256,
    httpsPort: 8443,
    download: ANCHOR_PATH,
    message: body.message,
  });
  assert.equal(typeof body.message, 'string');
  assert.ok(body.message.length > 0);
});

test('status when a download is not offered carries no download path but still shows the fingerprint it knows', async (t) => {
  for (const [report, status] of [
    [unknownReport(), ENROLMENT_UNKNOWN],
    [notRequiredReport(), ENROLMENT_NOT_REQUIRED],
  ]) {
    const { port } = await startApp(t, { tls: stubTls(report) });
    const body = json(await httpCall(port, STATUS_PATH));
    assert.equal(body.active, true);
    assert.equal(body.enrolmentStatus, status);
    assert.equal(body.fingerprint, report.fingerprint);
    assert.equal('download' in body, false);
    assert.ok(body.message.length > 0);
  }
});

test('status with no credential: inactive, null enrolment status, null fingerprint, no download', async (t) => {
  const { port } = await startApp(t, { tls: stubTls(inactiveReport()) });
  const response = await httpCall(port, STATUS_PATH);

  assert.equal(response.status, 200);
  const body = json(response);
  assert.deepEqual(body, {
    active: false,
    enrolmentStatus: null,
    strategy: null,
    fingerprint: null,
    httpsPort: null,
    message: body.message,
  });
  assert.match(body.message, /HTTPS is not running/i);
});

test('a provisioning failure reason, which can embed file paths and secrets, never reaches either endpoint', async (t) => {
  const reason =
    'provided: could not read key file "C:\\Users\\kim\\certs\\host.key": EACCES; passphrase hunter2';
  const { port } = await startApp(t, { tls: stubTls(inactiveReport(reason)) });
  const status = await httpCall(port, STATUS_PATH);
  const anchor = await httpCall(port, ANCHOR_PATH);

  for (const response of [status, anchor]) {
    for (const leak of ['C:\\', 'host.key', 'EACCES', 'hunter2', 'certs']) {
      assert.equal(response.text.includes(leak), false, `${leak} must not be served`);
    }
    assert.match(response.text, /server/i, 'points the operator at the server for the reason');
  }
  // The "could not be started" wording tells a failure apart from "never enabled".
  assert.match(json(status).message, /could not be started/i);
});

test('a failure reason on an otherwise active report is not served either', async (t) => {
  const report = requiredReport({ failureReason: 'mkcert: could not read "C:\\secret\\ca"' });
  const { port } = await startApp(t, { tls: stubTls(report) });
  for (const path of [STATUS_PATH, ANCHOR_PATH]) {
    const response = await httpCall(port, path);
    assert.equal(response.text.includes('secret'), false);
    assert.equal(response.text.includes('failureReason'), false);
  }
});

// --- methods, guards, allow-list -------------------------------------------------------

test('only GET is served on both endpoints; anything else is 405 with the app usual JSON', async (t) => {
  const { port } = await startApp(t, { tls: stubTls(requiredReport()) });
  for (const path of [ANCHOR_PATH, STATUS_PATH]) {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await httpCall(port, path, { method });
      assert.equal(response.status, 405, `${method} ${path}`);
      assert.match(response.headers['content-type'], /^application\/json/);
      assert.equal(json(response).error, 'GET required');
      assert.equal(response.headers['content-disposition'], undefined);
    }
  }
});

test('the host and origin guards still run before the endpoints', async (t) => {
  const { port } = await startApp(t, { tls: stubTls(requiredReport()) });
  for (const path of [ANCHOR_PATH, STATUS_PATH]) {
    const hostile = await httpCall(port, path, { headers: { host: 'evil.example' } });
    assert.equal(hostile.status, 403, `hostile Host ${path}`);
    const crossOrigin = await httpCall(port, path, {
      headers: { host: `127.0.0.1:${port}`, origin: 'http://evil.example' },
    });
    assert.equal(crossOrigin.status, 403, `cross-origin ${path}`);
    assert.equal(crossOrigin.headers['content-type'], 'application/json; charset=utf-8');
    // Control: the same-origin request is served.
    const same = await httpCall(port, path, {
      headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` },
    });
    assert.equal(same.status, 200, `same-origin ${path}`);
  }
});

test('with TLS active the plaintext listener serves both endpoints without redirecting, while ordinary paths still redirect', async (t) => {
  const { port } = await startApp(t, { tls: stubTls(requiredReport()) });
  for (const path of [ANCHOR_PATH, STATUS_PATH]) {
    const response = await httpCall(port, path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.location, undefined, path);
  }
  // Control: this really is the "TLS active" configuration, in which anything else redirects.
  const other = await httpCall(port, '/api/info');
  assert.equal(other.status, 307);
});

test('the human enrolment page is not part of this task: /trust is still a 404', async (t) => {
  const { port } = await startApp(t, { tls: stubTls(requiredReport()) });
  assert.equal((await httpCall(port, '/trust')).status, 404);
  assert.deepEqual(PLAINTEXT_ALLOWED_PATHS, ['/trust', ANCHOR_PATH, STATUS_PATH]);
});

// --- the report the listener retains ---------------------------------------------------

// The report shape ensureCertificate() returns, with the anchor a strategy would hand back.
const ok = (credential, anchor, overrides = {}) => ({
  ok: true,
  attempted: true,
  strategy: 'mkcert',
  credential,
  anchor,
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
function fakeEnsure(...outcomes) {
  const ensure = () => (outcomes.length > 1 ? outcomes.shift() : outcomes[0]);
  return ensure;
}
const settingsFor = (overrides = {}) => ({ ...defaultTlsSettings(), port: 0, ...overrides });

// A real listener around a real app that reads the listener's live state through the same
// `{ status, report }` surface main.mjs hands it: exactly the production wiring. The
// circular reference (app needs the listener, listener needs the app's handler) is
// resolved lazily, so requests only ever run after both exist.
function makeListener(t, { ensureCertificate, settings = settingsFor() }) {
  let listener;
  const app = createHttpApp({
    serverName: 'Test PC',
    tls: { status: () => listener.status(), report: () => listener.report() },
  });
  listener = createTlsListener({
    settings,
    requestListener: app.requestListener,
    host: '127.0.0.1',
    ensureCertificate,
    log: () => {},
  });
  t.after(() => listener.close());
  return listener;
}

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

test('before any attempt the listener reports inactive, with no failure', (t) => {
  const listener = makeListener(t, { ensureCertificate: fakeEnsure(ok(VALID, validAnchor)) });
  assert.deepEqual(listener.report(), {
    active: false,
    enrolmentStatus: null,
    strategy: null,
    anchor: null,
    fingerprint: null,
    failureReason: null,
  });
});

test('once bound, report() describes the served credential through anchorReport: one fingerprint for every reader', async (t) => {
  const listener = makeListener(t, { ensureCertificate: fakeEnsure(ok(VALID, validAnchor)) });
  await listener.attempt();

  const report = listener.report();
  assert.equal(report.active, true);
  assert.equal(report.enrolmentStatus, ENROLMENT_REQUIRED);
  assert.equal(report.strategy, 'mkcert');
  assert.equal(report.anchor, validAnchor);
  assert.equal(report.fingerprint, validAnchor.fingerprint256);
  assert.equal(report.failureReason, null);
  // The report carries the anchor and status only, never the credential.
  assert.deepEqual(Object.keys(report).sort(), [
    'active',
    'anchor',
    'enrolmentStatus',
    'failureReason',
    'fingerprint',
    'strategy',
  ]);
});

test('rotation updates the report to the replacement credential', async (t) => {
  const listener = makeListener(t, {
    ensureCertificate: fakeEnsure(
      ok(VALID, validAnchor),
      ok(EXPIRED, expiredAnchor, { strategy: 'windows-self-signed' }),
    ),
  });
  await listener.attempt();
  assert.equal(listener.report().fingerprint, validAnchor.fingerprint256);

  await listener.attempt();

  const report = listener.report();
  assert.equal(report.fingerprint, expiredAnchor.fingerprint256);
  assert.equal(report.strategy, 'windows-self-signed');
  assert.equal(report.anchor, expiredAnchor);
  assert.equal(report.failureReason, null);
});

test('a credential that fails to bind is never reported as served: inactive, with the failure reason', async (t) => {
  // A certificate and key that parse but do not belong together: createServer throws.
  const mismatched = { cert: VALID.cert, key: EXPIRED.key };
  const listener = makeListener(t, {
    ensureCertificate: fakeEnsure(ok(mismatched, validAnchor)),
  });
  await listener.attempt();

  const report = listener.report();
  assert.equal(report.active, false);
  assert.equal(report.enrolmentStatus, null);
  assert.equal(report.anchor, null, 'the anchor of a credential that never served is not retained');
  assert.equal(report.fingerprint, null);
  assert.equal(typeof report.failureReason, 'string');
  assert.ok(report.failureReason.length > 0);
});

test('a port already in use and an unbindable port both leave the report inactive, each with a reason', async (t) => {
  const { port } = await occupyPort(t);
  const busy = makeListener(t, {
    settings: settingsFor({ port }),
    ensureCertificate: fakeEnsure(ok(VALID, validAnchor)),
  });
  await busy.attempt();
  assert.equal(busy.report().active, false);
  assert.equal(busy.report().anchor, null);
  assert.match(busy.report().failureReason, /already in use/);

  const unbindable = makeListener(t, {
    settings: settingsFor({ port: 70000 }),
    ensureCertificate: fakeEnsure(ok(VALID, validAnchor)),
  });
  await unbindable.attempt();
  assert.equal(unbindable.report().active, false);
  assert.equal(unbindable.report().anchor, null);
  assert.ok(unbindable.report().failureReason.length > 0);
});

test('no strategy succeeding, and an ensureCertificate that throws, leave the report inactive with a reason', async (t) => {
  const none = makeListener(t, {
    ensureCertificate: fakeEnsure(failed('mkcert: mkcert is not available')),
  });
  await none.attempt();
  assert.equal(none.report().active, false);
  assert.equal(none.report().failureReason, 'mkcert: mkcert is not available');

  const throwing = makeListener(t, {
    ensureCertificate: () => {
      throw new Error('unexpected explosion');
    },
  });
  await throwing.attempt();
  assert.equal(throwing.report().active, false);
  assert.match(throwing.report().failureReason, /unexpected explosion/);
});

test('mode off never sets a failure reason', async (t) => {
  const listener = makeListener(t, {
    settings: settingsFor({ mode: 'off' }),
    ensureCertificate: () => assert.fail('mode off must not provision'),
  });
  await listener.attempt();
  assert.equal(listener.report().active, false);
  assert.equal(listener.report().failureReason, null);
});

test('a failed re-check keeps describing the credential still serving, and records the failure', async (t) => {
  const listener = makeListener(t, {
    ensureCertificate: fakeEnsure(
      ok(VALID, validAnchor),
      failed('mkcert: mkcert -CAROOT exited 1'),
    ),
  });
  await listener.attempt();
  await listener.attempt();

  const report = listener.report();
  assert.equal(report.active, true);
  assert.equal(report.fingerprint, validAnchor.fingerprint256);
  assert.equal(report.failureReason, 'mkcert: mkcert -CAROOT exited 1');
});

test('a replacement credential that cannot be loaded is not reported as served; the old one still is', async (t) => {
  const listener = makeListener(t, {
    ensureCertificate: fakeEnsure(
      ok(VALID, validAnchor),
      ok({ cert: 'not a certificate', key: 'not a key' }, expiredAnchor),
    ),
  });
  await listener.attempt();
  await listener.attempt();

  const report = listener.report();
  assert.equal(report.active, true);
  assert.equal(report.fingerprint, validAnchor.fingerprint256, 'not the failed replacement');
  assert.equal(report.anchor, validAnchor);
  assert.match(report.failureReason, /rotation failed/);
});

test('a later success clears the failure reason, on rotate and on a first bind after a failed one', async (t) => {
  const rotating = makeListener(t, {
    ensureCertificate: fakeEnsure(
      ok(VALID, validAnchor),
      failed('mkcert: transient'),
      ok(EXPIRED, expiredAnchor),
    ),
  });
  await rotating.attempt();
  await rotating.attempt();
  assert.equal(rotating.report().failureReason, 'mkcert: transient');
  await rotating.attempt();
  assert.equal(rotating.report().failureReason, null);
  assert.equal(rotating.report().fingerprint, expiredAnchor.fingerprint256);

  const { port, release } = await occupyPort(t);
  const binding = makeListener(t, {
    settings: settingsFor({ port }),
    ensureCertificate: fakeEnsure(ok(VALID, validAnchor)),
  });
  await binding.attempt();
  assert.match(binding.report().failureReason, /already in use/);
  await release();
  await binding.attempt();
  assert.equal(binding.report().active, true);
  assert.equal(binding.report().failureReason, null);
  assert.equal(binding.report().fingerprint, validAnchor.fingerprint256);
});

test('after close() the report is inactive', async (t) => {
  const listener = makeListener(t, { ensureCertificate: fakeEnsure(ok(VALID, validAnchor)) });
  await listener.attempt();
  await listener.close();
  assert.equal(listener.report().active, false);
  assert.equal(listener.report().anchor, null);
});

// --- end to end over real listeners ----------------------------------------------------

test('over a real TLS listener both endpoints work on HTTPS and, unredirected, on the plaintext listener', async (t) => {
  const listener = makeListener(t, { ensureCertificate: fakeEnsure(ok(VALID, validAnchor)) });
  await listener.attempt();
  const { port: tlsPort } = listener.status();
  // The plaintext app reads the same live listener, exactly as main.mjs wires it.
  const plaintext = await startApp(t, {
    tls: { status: () => listener.status(), report: () => listener.report() },
  });

  for (const call of [
    (path) => httpsCall(tlsPort, path),
    (path) => httpCall(plaintext.port, path),
  ]) {
    const file = await call(ANCHOR_PATH);
    assert.equal(file.status, 200);
    assert.equal(file.headers.location, undefined);
    assert.equal(file.headers['content-type'], 'application/x-x509-ca-cert');
    assert.equal(file.headers['content-disposition'], FILENAME_HEADER);
    assert.deepEqual(file.bytes, validAnchor.raw);

    const status = json(await call(STATUS_PATH));
    assert.equal(status.active, true);
    assert.equal(status.enrolmentStatus, ENROLMENT_REQUIRED);
    assert.equal(status.fingerprint, sha256Colon(file.bytes));
    assert.equal(status.httpsPort, tlsPort);
    assert.equal(status.download, ANCHOR_PATH);
  }
  // Control: a non-enrolment plaintext path really does redirect in this configuration.
  assert.equal((await httpCall(plaintext.port, '/api/info')).status, 307);
});

test('the endpoints follow a rotation: the download and the fingerprint change together', async (t) => {
  const listener = makeListener(t, {
    ensureCertificate: fakeEnsure(ok(VALID, validAnchor), ok(EXPIRED, expiredAnchor)),
  });
  await listener.attempt();
  const { port } = listener.status();
  const before = await httpsCall(port, ANCHOR_PATH);
  assert.deepEqual(before.bytes, validAnchor.raw);

  await listener.attempt();

  const after = await httpsCall(port, ANCHOR_PATH);
  const status = json(await httpsCall(port, STATUS_PATH));
  assert.deepEqual(after.bytes, expiredAnchor.raw);
  assert.equal(status.fingerprint, sha256Colon(after.bytes));
  assert.notEqual(status.fingerprint, sha256Colon(before.bytes));
});

test('with a failed listener the plaintext endpoints report the failure instead of serving a file', async (t) => {
  const listener = makeListener(t, {
    ensureCertificate: fakeEnsure(failed('provided: could not read key file "C:\\certs\\k.key"')),
  });
  await listener.attempt();
  const plaintext = await startApp(t, {
    tls: { status: () => listener.status(), report: () => listener.report() },
  });

  const anchor = await httpCall(plaintext.port, ANCHOR_PATH);
  assert.equal(anchor.status, 503);
  assert.equal(anchor.text.includes('C:\\certs'), false);
  const status = json(await httpCall(plaintext.port, STATUS_PATH));
  assert.equal(status.active, false);
  assert.equal(status.enrolmentStatus, null);
  assert.equal(status.fingerprint, null);
});
