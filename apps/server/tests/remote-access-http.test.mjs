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
    connectionMode: 'approved-only',
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
  const request = (method, path, { host = 'vnc.example.com', port: hostPort = port, body } = {}) =>
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
            host: hostPort === 443 ? host : `${host}:${hostPort}`,
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

test('the stream answer names the public address for an internet client only', async (t) => {
  const sessionStore = new SessionStore({ maxSessions: 1 });
  const approvedClients = await ApprovedClientStore.open(null, { keys: sessionStore.keys });
  const sdp = [
    'v=0',
    'm=video 40001 UDP/TLS/RTP/SAVPF 96',
    'a=candidate:1 1 UDP 2015363327 192.168.1.20 40001 typ host',
    '',
  ].join('\r\n');
  const peer = { internet: false };
  const offered = [];
  const app = createHttpApp({
    sessionStore,
    approvedClients,
    runtime: {
      offerVideo: async (_, request) => {
        offered.push(request.sdp);
        return { streamId: 's1', type: 'answer', sdp };
      },
      list: () => [],
    },
    access: {
      snapshot: () => ({
        remoteAccess: true,
        publicHostnames: ['vnc.example.com'],
        publicPort: 443,
      }),
    },
    peerNetwork: { isInternet: () => peer.internet },
    resolvePublicIpv4: async () => ['203.0.113.10'],
  });
  const secure = createTlsServer(CREDENTIAL, app.requestListener);
  await new Promise((resolve) => secure.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    secure.closeAllConnections();
    await new Promise((resolve) => secure.close(resolve));
    app.emit('close');
  });
  const { sessionId } = sessionStore.connect(sessionStore.password, '127.0.0.1');
  const offer = () =>
    new Promise((resolve, reject) => {
      const data = JSON.stringify({
        sdp: 'v=0\r\na=candidate:1 1 udp 2122260223 192.168.1.40 55000 typ host\r\n',
      });
      const outgoing = httpsRequest(
        {
          host: '127.0.0.1',
          port: secure.address().port,
          method: 'POST',
          path: '/api/stream-offer',
          rejectUnauthorized: false,
          headers: {
            host: 'vnc.example.com',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(data),
            authorization: `Bearer ${sessionId}`,
          },
        },
        (response) => {
          let text = '';
          response.on('data', (chunk) => (text += chunk));
          response.on('end', () => resolve(JSON.parse(text)));
        },
      );
      outgoing.on('error', reject);
      outgoing.end(data);
    });
  assert.match((await offer()).sdp, / 192\.168\.1\.20 40001 /, 'a local client is unchanged');
  peer.internet = true;
  const rewritten = (await offer()).sdp;
  assert.match(rewritten, / 203\.0\.113\.10 40001 typ host/);
  assert.equal(rewritten.includes('192.168.'), false);
  assert.match(offered[0], /192\.168\.1\.40/, 'a local client offer reaches the worker unchanged');
  assert.equal(
    offered[1].includes('a=candidate:'),
    false,
    'an internet offer loses private candidates',
  );
});

test('an internet client is never served over plain HTTP, whatever the local scope says', async (t) => {
  const app = createHttpApp({
    access: { snapshot: () => ({ remoteAccess: true, publicHostnames: ['vnc.example.com'] }) },
    peerNetwork: { isInternet: () => true },
    localSessionScope: { allows: () => true },
  });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${app.address().port}/`);
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, 'Use HTTPS.');
});

test('a router forwarding the public HTTPS port works only when that port is configured', async (t) => {
  const { request, settings } = await withRemote(t);
  assert.equal((await request('GET', '/', { port: 443 })).status, 421);
  settings.publicPort = 443;
  assert.equal((await request('GET', '/', { port: 443 })).status, 200);
  assert.equal(
    (await request('GET', '/', { host: '127.0.0.1', port: 443 })).status,
    421,
    'only the public names may use the public port',
  );
});
