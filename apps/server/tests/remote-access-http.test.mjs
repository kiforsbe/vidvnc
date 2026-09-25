// An internet client as the HTTP handler sees it: a stubbed peer classifier plays the
// internet from 127.0.0.1, over a real TLS listener carrying the committed test-only
// certificate, with the Host header an internet browser would send.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer as createTlsServer, request as httpsRequest } from 'node:https';
import { createHttpApp } from '../src/http-app.mjs';
import { ApprovedClientStore } from '../src/approved-clients.mjs';
import { SessionStore } from '../src/session-store.mjs';

const fixture = (path) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/tls/${path}`, import.meta.url)));
const CREDENTIAL = { cert: fixture('valid/cert.pem'), key: fixture('valid/key.pem') };

async function withRemote(t, { remoteAccess = true, internet = true } = {}) {
  const settings = {
    connectionMode: 'session-key',
    defaultControl: 'approval',
    publicName: 'Office PC',
    remoteAccess,
    publicHostnames: ['vnc.example.com', '203.0.113.10'],
  };
  const peer = { internet };
  const sessionStore = new SessionStore({ maxSessions: 2 });
  const approvedClients = await ApprovedClientStore.open(null, { keys: sessionStore.keys });
  const app = createHttpApp({
    sessionStore,
    approvedClients,
    access: { snapshot: () => structuredClone(settings) },
    peerNetwork: { isInternet: () => peer.internet },
    localSessionScope: { allows: () => !peer.internet },
  });
  const secure = createTlsServer(CREDENTIAL, app.requestListener);
  await new Promise((resolve) => secure.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    secure.closeAllConnections();
    await new Promise((resolve) => secure.close(resolve));
    app.emit('close');
  });
  const port = secure.address().port;
  const request = (method, path, { host = 'vnc.example.com', body } = {}) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body);
      const outgoing = httpsRequest(
        {
          host: '127.0.0.1',
          port,
          method,
          path,
          rejectUnauthorized: false,
          headers: {
            host: `${host}:${port}`,
            ...(data
              ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
              : {}),
          },
        },
        (response) => {
          let text = '';
          response.on('data', (chunk) => (text += chunk));
          response.on('end', () =>
            resolve({
              status: response.statusCode,
              headers: response.headers,
              text,
              json: () => JSON.parse(text),
            }),
          );
        },
      );
      outgoing.on('error', reject);
      outgoing.end(data);
    });
  return { request, settings, peer, sessionStore, approvedClients };
}

test('remote access off: an internet client gets nothing at all', async (t) => {
  const { request } = await withRemote(t, { remoteAccess: false });
  for (const [method, path] of [
    ['GET', '/'],
    ['GET', '/api/info'],
    ['POST', '/api/approved-clients/sign-in'],
  ]) {
    const response = await request(method, path, { body: method === 'POST' ? {} : undefined });
    assert.equal(response.status, 403, path);
    assert.equal(response.json().error, 'Remote access is off.');
  }
});

test('remote access on: the public name works, over HTTPS, with HSTS', async (t) => {
  const { request } = await withRemote(t);
  const page = await request('GET', '/');
  assert.equal(page.status, 200);
  assert.equal(page.headers['strict-transport-security'], 'max-age=15552000');
  assert.equal((await request('GET', '/api/info', { host: '203.0.113.10' })).status, 200);
  assert.equal((await request('GET', '/', { host: 'attacker.example' })).status, 403);
});

test('remote access on: an internet client cannot use any short code, or enrol', async (t) => {
  const { request, sessionStore } = await withRemote(t);
  const key = sessionStore.keys.createSetup().key;
  const start = await request('POST', '/api/key-start', { body: { key } });
  assert.equal(start.status, 403);
  assert.match(start.json().error, /local network only/);
  assert.notEqual(sessionStore.keys.inspect(key), null, 'the code was not consumed');
  assert.equal((await request('GET', '/trust')).status, 403);
  assert.equal((await request('GET', '/api/trust/anchor')).status, 403);
});

test('the public names are refused while remote access is off, even from the local network', async (t) => {
  const { request } = await withRemote(t, { remoteAccess: false, internet: false });
  assert.equal((await request('GET', '/')).status, 403);
  const local = await request('GET', '/', { host: '127.0.0.1' });
  assert.equal(local.status, 200);
  assert.equal(local.headers['strict-transport-security'], undefined);
});

test('a device set up on the LAN signs in from the internet, and its request says where it came from', async (t) => {
  const { request, peer, sessionStore, approvedClients } = await withRemote(t, { internet: false });
  const setup = sessionStore.keys.createSetup();
  const start = await request('POST', '/api/key-start', {
    host: '127.0.0.1',
    body: { key: setup.key },
  });
  assert.equal(start.status, 202);
  const { registrationTicket } = start.json();
  peer.internet = true;
  const registered = await request('POST', '/api/approved-clients/register', {
    body: {
      registrationTicket,
      deviceName: 'Phone',
      username: 'kim',
      password: 'correct horse battery staple',
      installationId: 'browser-remote-1',
      client: 'Safari',
    },
  });
  assert.equal(registered.status, 202);
  assert.equal(approvedClients.status().pending[0].network, 'Internet');
  const registration = registered.json();
  await approvedClients.approve(registration.requestId);
  const credential = (
    await request('POST', '/api/approved-clients/status', { body: registration })
  ).json();
  const signIn = await request('POST', '/api/approved-clients/sign-in', {
    body: {
      clientId: credential.clientId,
      clientSecret: credential.clientSecret,
      username: 'kim',
      password: 'correct horse battery staple',
    },
  });
  assert.equal(signIn.status, 201);
});
