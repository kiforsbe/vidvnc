// Tests that the enrolment page (GET /trust) works over the plaintext listener, which is
// the only way a device that does not yet trust the host can reach it.
//
// The plaintext listener redirects everything to HTTPS once TLS is active, except an
// allow-list. A page is not one request: its script, stylesheets and every module it
// imports are separate requests, and each one the allow-list misses would be redirected,
// cross-origin, to a certificate the device does not trust — breaking the page exactly
// when it is needed. So this file reads the real `trust.html` (and the modules its script
// imports), collects every asset the page loads, and asserts that each is allow-listed AND
// served with a 200 by a real `createHttpApp` reporting TLS active; and, the other half of
// the ruling, that the allow-list holds nothing else.
//
// No provisioning of any kind: `tls` is a stub, the servers bind ephemeral loopback ports
// (never 4382/4383) and every one is stopped in `t.after`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createHttpApp, PLAINTEXT_ALLOWED_PATHS } from '../../src/http-app.mjs';
import { anchorReport } from '../../src/tls/anchor.mjs';

const webClient = (name) => new URL(import.meta.resolve(`@vidvnc/web-client/${name}`));
const readWebClient = (name) => readFileSync(webClient(name));

const TRUST_API_PATHS = ['/api/trust/anchor', '/api/trust/status'];

// Every asset the page loads over the wire: what trust.html references, plus (recursively)
// what each script and module it loads imports. Paths are as the browser requests them.
function pageAssets() {
  const html = readWebClient('trust.html').toString('utf8');
  const references = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((reference) => !reference.startsWith('#'));
  const found = new Set();
  const visit = (path) => {
    assert.match(path, /^\/[^/]/, `${path} is a same-origin absolute path`);
    if (found.has(path)) return;
    found.add(path);
    if (!path.endsWith('.js')) return;
    const script = readWebClient(path.slice(1)).toString('utf8');
    for (const match of script.matchAll(/(?:from\s+|import\s*\(\s*)'(\.\/[^']+)'/g))
      visit(`/${match[1].slice(2)}`);
  };
  references.forEach(visit);
  return [...found].sort();
}

const activeTls = () => ({
  status: () => ({ active: true, port: 8443 }),
  report: () => ({ ...anchorReport(null), failureReason: null }),
});

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
  return server.address().port;
}

// Plain HTTP with full control over the method; fetch would follow the redirect.
function httpCall(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, method }, (response) => {
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
    });
    request.on('error', reject);
    request.end();
  });
}

test('the page loads a specific, non-empty set of assets', () => {
  // Guards the guard: an empty or shrunken list would make the tests below vacuous.
  const assets = pageAssets();
  for (const expected of [
    '/theme.js',
    '/style.css',
    '/shell.css',
    '/trust.css',
    '/trust.js',
    '/trust-model.js',
    '/trust-instructions.js',
  ])
    assert.ok(assets.includes(expected), `${expected} is among the assets the page loads`);
});

test('every asset the page loads is on the plaintext allow-list', () => {
  for (const asset of pageAssets())
    assert.ok(PLAINTEXT_ALLOWED_PATHS.includes(asset), `${asset} would be redirected to HTTPS`);
  assert.ok(PLAINTEXT_ALLOWED_PATHS.includes('/trust'));
});

test('the allow-list is exactly the page, its assets and the two enrolment endpoints, and nothing else', () => {
  assert.deepEqual(
    [...PLAINTEXT_ALLOWED_PATHS].sort(),
    ['/trust', ...pageAssets(), ...TRUST_API_PATHS].sort(),
  );
  for (const path of PLAINTEXT_ALLOWED_PATHS)
    assert.doesNotMatch(path, /[*?]|\/$/, `${path} is a plain path, not a pattern or a prefix`);
});

test('with TLS active, the page and every asset it loads are served 200 over plaintext, unredirected', async (t) => {
  const port = await startApp(t, { tls: activeTls() });
  for (const path of ['/trust', ...pageAssets()]) {
    const response = await httpCall(port, path);
    assert.equal(response.status, 200, `${path} answered ${response.status}`);
    assert.equal(response.headers.location, undefined, `${path} is not redirected`);
    assert.ok(response.bytes.length > 0, `${path} has a body`);
  }
});

test('the page is served as HTML with the same headers as the other pages', async (t) => {
  const port = await startApp(t, { tls: activeTls() });
  const response = await httpCall(port, '/trust');
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'text/html');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  const csp = response.headers['content-security-policy'];
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  assert.deepEqual(response.bytes, readWebClient('trust.html'));
});

test('each asset is served with the content type a browser needs to run it', async (t) => {
  const port = await startApp(t, { tls: activeTls() });
  for (const path of pageAssets()) {
    const response = await httpCall(port, path);
    const expected = path.endsWith('.js') ? 'text/javascript' : 'text/css';
    assert.equal(response.headers['content-type'], expected, path);
    assert.equal(response.headers['cache-control'], 'no-store', path);
    assert.deepEqual(response.bytes, readWebClient(path.slice(1)), path);
  }
});

test('the page is also served when TLS is not active, and on a host with no tls option at all', async (t) => {
  for (const options of [{}, { tls: { status: () => ({ active: false, port: null }) } }]) {
    const port = await startApp(t, options);
    const response = await httpCall(port, '/trust');
    assert.equal(response.status, 200);
    assert.equal(response.headers.location, undefined);
  }
});

test('the page is GET only', async (t) => {
  const port = await startApp(t, { tls: activeTls() });
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await httpCall(port, '/trust', method);
    assert.equal(response.status, 405, method);
    assert.notEqual(response.status, 200);
    assert.doesNotMatch(response.text, /<html/i);
  }
});

test('a path the page does not load is still redirected to HTTPS in that same configuration', async (t) => {
  const port = await startApp(t, { tls: activeTls() });
  for (const path of ['/app.js', '/', '/diagnostics.js', '/approved-client.js', '/api/info']) {
    const response = await httpCall(port, path);
    assert.equal(response.status, 307, path);
    assert.equal(response.headers.location, `https://127.0.0.1:8443${path}`, path);
  }
});

test('the allow-list matches whole paths only: near-misses and prefixes are still redirected', async (t) => {
  const port = await startApp(t, { tls: activeTls() });
  for (const path of [
    '/trust/',
    '/trust/anything',
    '/trust.html',
    '/trust.js.map',
    '/trust-extra.js',
    '/trust-model.jsx',
    '/api/trust',
    '/api/trust/anchor/extra',
  ]) {
    const response = await httpCall(port, path);
    assert.equal(response.status, 307, path);
  }
});
