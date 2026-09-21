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
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer as createTlsServer, request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import { createHttpApp, PLAINTEXT_ALLOWED_PATHS } from '../../src/http-app.mjs';
import { createTlsListener } from '../../src/tls/listener.mjs';
import { defaultTlsSettings } from '../../src/tls/tls-settings.mjs';

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

// Builds a listener bound to an ephemeral loopback port around a real plaintext app.
// `created` records every https.Server the listener builds, so rotation tests can prove it
// never built a second one.
async function withListener(options, run) {
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
  try {
    await run({ listener, log, created, app });
  } finally {
    await listener.close();
  }
}

// A plaintext listener whose redirect decision comes from `tls` (a listener, or any object
// with the same `status()`), i.e. exactly how main.mjs wires the two together.
async function withPlaintextServer(tls, run) {
  const server = createHttpApp({ serverName: 'Test PC', tls });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// --- client helpers --------------------------------------------------------------------

function requestOverTls(port, path) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      { host: '127.0.0.1', port, path, method: 'GET', rejectUnauthorized: false },
      (response) => {
        let body = '';
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve({ status: response.statusCode, body }));
      },
    );
    request.on('error', reject);
    request.end();
  });
}

// Connects with `rejectUnauthorized: false` (test-only self-signed fixtures, one of them
// deliberately expired) and reports which leaf the listener presented, by SHA-256
// fingerprint. `keepOpen` returns the live socket too, for tests about existing connections.
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

test('the plaintext allow-list is exactly the three ruled enrolment paths', () => {
  assert.deepEqual(PLAINTEXT_ALLOWED_PATHS, ['/trust', '/api/trust/anchor', '/api/trust/status']);
});

// --- serving and redirecting -----------------------------------------------------------

test('a TLS request to the secure port is served, over a real handshake against the fixture credential', () =>
  withListener({ ensureCertificate: fakeEnsure(ok(VALID)) }, async ({ listener, log }) => {
    await listener.attempt();
    const { active, port } = listener.status();
    assert.equal(active, true);

    const { status, body } = await requestOverTls(port, '/api/info');
    assert.equal(status, 200);
    assert.equal(JSON.parse(body).serverName, 'Test PC');
    assert.equal((await connectTls(port)).fingerprint, validFingerprint);
    assert.match(log.lines.join('\n'), /TLS ready on port \d+ \(strategy: mkcert\)/);
  }));

test('a plaintext request to a non-enrolment path redirects to the HTTPS equivalent, preserving path and query', () =>
  withListener({ ensureCertificate: fakeEnsure(ok(VALID)) }, async ({ listener }) => {
    await listener.attempt();
    const { port } = listener.status();
    await withPlaintextServer(listener, async (url) => {
      const response = await fetch(url + '/api/info?display=1&x=%20y', { redirect: 'manual' });
      assert.equal(response.status, 308);
      assert.equal(
        response.headers.get('location'),
        `https://127.0.0.1:${port}/api/info?display=1&x=%20y`,
      );
      // The redirect target really is serving.
      assert.equal((await requestOverTls(port, '/api/info?display=1')).status, 200);
    });
  }));

test('a plaintext POST also redirects, 308 preserving the method for a mid-session client', () =>
  withPlaintextServer({ status: () => ({ active: true, port: 8443 }) }, async (url) => {
    const response = await fetch(url + '/api/heartbeat', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('location'), 'https://127.0.0.1:8443/api/heartbeat');
  }));

test('a plaintext request to an enrolment path is served without redirect (still 404 until Task 11)', () =>
  withPlaintextServer({ status: () => ({ active: true, port: 8443 }) }, async (url) => {
    for (const path of PLAINTEXT_ALLOWED_PATHS) {
      const response = await fetch(url + path, { redirect: 'manual' });
      assert.notEqual(response.status, 308, path);
      assert.equal(response.status, 404, path);
    }
  }));

test('a request that arrived over TLS is never redirected, even to an enrolment path', () =>
  withListener({ ensureCertificate: fakeEnsure(ok(VALID)) }, async ({ listener }) => {
    // The shared handler is handed the listener's own status, so this is the path a real
    // HTTPS request takes through the redirect check.
    const app = createHttpApp({ serverName: 'Test PC', tls: listener });
    const secure = createTlsServer(VALID, app.requestListener);
    await new Promise((resolve) => secure.listen(0, '127.0.0.1', resolve));
    try {
      await listener.attempt();
      const port = secure.address().port;
      for (const path of ['/api/info', '/trust']) {
        const { status } = await requestOverTls(port, path);
        assert.notEqual(status, 308, path);
      }
    } finally {
      await new Promise((resolve) => secure.close(resolve));
    }
  }));

// --- failure table: no strategy succeeds -----------------------------------------------

test('no strategy succeeds in auto: plaintext serves the whole application exactly as today, no redirect, and the reason is logged', () =>
  withListener(
    {
      ensureCertificate: fakeEnsure(
        failed('mkcert: mkcert is not available; windows-self-signed: PowerShell unavailable'),
      ),
      createServer: () => assert.fail('no TLS server may be built without a credential'),
    },
    async ({ listener, log }) => {
      await listener.attempt();
      assert.deepEqual(listener.status(), { active: false, port: null });
      assert.match(log.lines.join('\n'), /TLS unavailable/);
      assert.match(log.lines.join('\n'), /mkcert is not available/);
      assert.match(log.lines.join('\n'), /PowerShell unavailable/);
      assert.match(log.lines.join('\n'), /Serving plaintext only/);

      await withPlaintextServer(listener, async (url) => {
        for (const path of ['/', '/api/info', ...PLAINTEXT_ALLOWED_PATHS]) {
          const response = await fetch(url + path, { redirect: 'manual' });
          assert.notEqual(response.status, 308, path);
        }
        const info = await (await fetch(url + '/api/info')).json();
        assert.equal(info.serverName, 'Test PC');
      });
    },
  ));

test('an ensureCertificate that throws is survived, logged, and leaves plaintext serving', () =>
  withListener(
    { ensureCertificate: fakeEnsure(new Error('unexpected explosion')) },
    async ({ listener, log }) => {
      await assert.doesNotReject(listener.attempt());
      assert.equal(listener.status().active, false);
      assert.match(log.lines.join('\n'), /unexpected explosion/);
    },
  ));

test('mode off consults nothing, binds nothing and logs nothing', () =>
  withListener(
    {
      settings: settingsFor({ mode: 'off' }),
      ensureCertificate: neverEnsure,
      createServer: () => assert.fail('mode off must never build a TLS server'),
    },
    async ({ listener, log }) => {
      await listener.attempt();
      assert.deepEqual(listener.status(), { active: false, port: null });
      assert.deepEqual(log.lines, []);
      await withPlaintextServer(listener, async (url) => {
        const response = await fetch(url + '/api/info', { redirect: 'manual' });
        assert.equal(response.status, 200);
      });
    },
  ));

// --- failure table: provided certificate fails -----------------------------------------

test('a failing provided certificate is reported as a configuration error, and nothing is generated in its place', () => {
  const ensure = fakeEnsure(
    failed('provided: certificate "C:\\certs\\host.pem" has expired (valid until 2025-01-01)'),
  );
  return withListener(
    {
      settings: settingsFor({
        mode: 'provided',
        certificatePath: 'C:\\certs\\host.pem',
        keyPath: 'C:\\certs\\host.key',
      }),
      ensureCertificate: ensure,
      createServer: () => assert.fail('no TLS server may be built from a failed credential'),
    },
    async ({ listener, log }) => {
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

      await withPlaintextServer(listener, async (url) => {
        const response = await fetch(url + '/api/info', { redirect: 'manual' });
        assert.equal(response.status, 200);
      });
    },
  );
});

// --- failure table: TLS port already in use --------------------------------------------

// The timeout turns a regression (a bind failure nobody handles, so the attempt never settles)
// into a fast, named failure instead of a hung run.
test(
  'a TLS port already in use is reported naming the port, plaintext keeps serving, and the process survives',
  { timeout: 5000 },
  async () => {
    const occupier = createTlsServer(VALID);
    await new Promise((resolve) => occupier.listen(0, '127.0.0.1', resolve));
    const port = occupier.address().port;
    try {
      await withListener(
        { settings: settingsFor({ port }), ensureCertificate: fakeEnsure(ok(VALID)) },
        async ({ listener, log }) => {
          // If the bind failure became an unhandled 'error' event this would take the whole
          // test process down rather than resolve.
          await assert.doesNotReject(listener.attempt());

          assert.equal(listener.status().active, false);
          const text = log.lines.join('\n');
          assert.match(text, new RegExp(`TLS port ${port} is already in use`));
          assert.match(text, /Serving plaintext only/);

          // Because TLS is not actually up, plaintext must not redirect anyone toward a
          // port nothing is listening on.
          await withPlaintextServer(listener, async (url) => {
            const response = await fetch(url + '/api/info', { redirect: 'manual' });
            assert.equal(response.status, 200);
          });
        },
      );
    } finally {
      await new Promise((resolve) => occupier.close(resolve));
    }
  },
);

test(
  'once the port is freed, the periodic re-check brings TLS up without a restart',
  { timeout: 5000 },
  async () => {
    const occupier = createTlsServer(VALID);
    await new Promise((resolve) => occupier.listen(0, '127.0.0.1', resolve));
    const port = occupier.address().port;
    await withListener(
      { settings: settingsFor({ port }), ensureCertificate: fakeEnsure(ok(VALID)) },
      async ({ listener }) => {
        await listener.attempt();
        assert.equal(listener.status().active, false);

        await new Promise((resolve) => occupier.close(resolve));
        await listener.attempt();

        assert.deepEqual(listener.status(), { active: true, port });
        assert.equal((await connectTls(port)).fingerprint, validFingerprint);
      },
    );
  },
);

// --- failure table: certificate expires while running ----------------------------------

test('rotation swaps the credential in place, never closing or rebuilding the listener, and a connection made after rotation sees the new certificate', () =>
  withListener(
    { ensureCertificate: fakeEnsure(ok(VALID), ok(EXPIRED, { strategy: 'windows-self-signed' })) },
    async ({ listener, created }) => {
      await listener.attempt();
      const { port } = listener.status();
      assert.equal(created.length, 1);
      let closed = false;
      created[0].once('close', () => (closed = true));

      // A connection made before rotation, held open across it.
      const before = await connectTls(port, { keepOpen: true });
      assert.equal(before.fingerprint, validFingerprint);

      await listener.attempt(); // the periodic re-check finds a replacement credential

      const after = await connectTls(port);
      assert.equal(after.fingerprint, expiredFingerprint);
      assert.notEqual(after.fingerprint, before.fingerprint);

      // The same listener throughout: one server ever built, same port, never closed,
      // still listening, and the connection opened before rotation was not dropped.
      assert.equal(created.length, 1);
      assert.deepEqual(listener.status(), { active: true, port });
      assert.equal(created[0].listening, true);
      assert.equal(closed, false);
      assert.equal(before.socket.destroyed, false);
      before.socket.end();

      // The shared request handler still answers after rotation.
      assert.equal((await requestOverTls(port, '/api/info')).status, 200);
    },
  ));

test('a re-check that finds nothing new leaves a running listener untouched, and one that fails keeps the current certificate', () =>
  withListener(
    {
      ensureCertificate: fakeEnsure(
        ok(VALID),
        ok(VALID),
        failed('mkcert: mkcert -CAROOT exited 1'),
      ),
    },
    async ({ listener, log, created }) => {
      await listener.attempt();
      const { port } = listener.status();

      await listener.attempt();
      assert.equal((await connectTls(port)).fingerprint, validFingerprint);

      await listener.attempt();
      assert.equal((await connectTls(port)).fingerprint, validFingerprint);
      assert.equal(listener.status().active, true);
      assert.equal(created.length, 1);
      assert.match(log.lines.join('\n'), /TLS re-check failed \(mkcert: mkcert -CAROOT exited 1\)/);
      assert.match(log.lines.join('\n'), /Continuing with the current certificate/);
    },
  ));

test('a credential that cannot be loaded during rotation is reported and the old certificate keeps serving', () =>
  withListener(
    {
      ensureCertificate: fakeEnsure(ok(VALID), ok({ cert: 'not a certificate', key: 'not a key' })),
    },
    async ({ listener, log }) => {
      await listener.attempt();
      const { port } = listener.status();

      await assert.doesNotReject(listener.attempt());

      assert.match(log.lines.join('\n'), /TLS certificate rotation failed/);
      assert.equal(listener.status().active, true);
      assert.equal((await connectTls(port)).fingerprint, validFingerprint);
    },
  ));

// --- lifecycle -------------------------------------------------------------------------

test('overlapping attempts join one provisioning call rather than racing it', () => {
  const ensure = fakeEnsure(ok(VALID));
  return withListener({ ensureCertificate: ensure }, async ({ listener, created }) => {
    await Promise.all([listener.attempt(), listener.attempt(), listener.attempt()]);
    assert.equal(ensure.calls.length, 1);
    assert.equal(created.length, 1);
    assert.equal(listener.status().active, true);
  });
});

test('warnings from provisioning are surfaced in the log when TLS comes up', () =>
  withListener(
    {
      ensureCertificate: fakeEnsure(
        ok(VALID, {
          strategy: 'provided',
          warnings: [
            'certificate "host.pem" does not cover this machine\'s current address(es): Thor',
          ],
        }),
      ),
    },
    async ({ listener, log }) => {
      await listener.attempt();
      assert.match(log.lines.join('\n'), /does not cover this machine's current address/);
    },
  ));

test('close() stops the TLS listener, reports inactive, and later attempts do nothing', () =>
  withListener({ ensureCertificate: fakeEnsure(ok(VALID)) }, async ({ listener }) => {
    await listener.attempt();
    const { port } = listener.status();

    await listener.close();
    assert.deepEqual(listener.status(), { active: false, port: null });
    await assert.rejects(connectTls(port), { code: 'ECONNREFUSED' });

    await listener.attempt();
    assert.equal(listener.status().active, false);
  }));
