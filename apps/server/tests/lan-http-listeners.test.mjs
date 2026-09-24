import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Agent, request as httpRequest } from 'node:http';
import { createHttpApp } from '../src/http-app.mjs';

const lan = await import('../src/lan-http-listeners.mjs').catch(() => ({}));

test('desired HTTP hosts never include public, link-local, wildcard, or ineligible preference IPs', () => {
  assert.equal(typeof lan.desiredHttpAddresses, 'function');
  const scope = {
    bindAddresses: ['192.168.10.12', 'fd12::42', '203.0.113.5', '169.254.1.2'],
  };
  assert.deepEqual(lan.desiredHttpAddresses(scope, '0.0.0.0'), [
    '127.0.0.1',
    '::1',
    '192.168.10.12',
    'fd12::42',
  ]);
  assert.deepEqual(lan.desiredHttpAddresses(scope, '192.168.10.12'), [
    '127.0.0.1',
    '::1',
    '192.168.10.12',
  ]);
  for (const preference of ['203.0.113.5', 'host.example', '127.0.0.1', 'localhost'])
    assert.deepEqual(lan.desiredHttpAddresses(scope, preference), ['127.0.0.1', '::1']);
});

class FakeServer extends EventEmitter {
  constructor(failHost = null) {
    super();
    this.failHost = failHost;
    this.closed = false;
  }

  listen(port, host, done) {
    this.host = host;
    this.port = port || 4399;
    queueMicrotask(() => {
      if (host === this.failHost) this.emit('error', new Error('bind denied'));
      else done();
    });
  }

  address() {
    return { address: this.host, port: this.port };
  }

  close(done) {
    this.closed = true;
    queueMicrotask(done);
  }

  closeAllConnections() {}
}

test('LAN listeners reconcile private/ULA address loss and never substitute a wildcard', async (t) => {
  assert.equal(typeof lan.createLanHttpListeners, 'function');
  const scope = { bindAddresses: ['192.168.10.12', 'fd12::42'], allows: () => true };
  const app = createHttpApp({ localSessionScope: scope });
  const created = [];
  const http = lan.createLanHttpListeners({
    port: 0,
    scope,
    hostPreference: '0.0.0.0',
    primaryServer: app,
    requestListener: app.requestListener,
    createServer: () => {
      const server = new FakeServer();
      created.push(server);
      return server;
    },
  });
  t.after(() => http.close());
  await http.start();
  assert.deepEqual(
    http.addresses().map((row) => row.host),
    ['127.0.0.1', '::1', '192.168.10.12', 'fd12::42'],
  );
  assert.ok(http.addresses().every((row) => row.port > 0));
  scope.bindAddresses = [];
  await http.reconcile();
  assert.deepEqual(
    http.addresses().map((row) => row.host),
    ['127.0.0.1', '::1'],
  );
  assert.equal(created.find((server) => server.host === '192.168.10.12').closed, true);
  assert.equal(created.find((server) => server.host === 'fd12::42').closed, true);
});

test('one optional LAN bind error does not widen or cancel other eligible binds', async (t) => {
  const scope = { bindAddresses: ['192.168.10.12', 'fd12::42'], allows: () => true };
  const app = createHttpApp({ localSessionScope: scope });
  const warnings = [];
  const http = lan.createLanHttpListeners({
    port: 0,
    scope,
    hostPreference: '0.0.0.0',
    primaryServer: app,
    requestListener: app.requestListener,
    createServer: () => new FakeServer('fd12::42'),
    log: (message) => warnings.push(message),
  });
  t.after(() => http.close());
  await http.start();
  assert.deepEqual(
    http.addresses().map((row) => row.host),
    ['127.0.0.1', '::1', '192.168.10.12'],
  );
  assert.ok(warnings.some((line) => line.includes('fd12::42')));
});

test('an explicit public HTTP host preference stays loopback-only and warns once', async (t) => {
  const scope = { bindAddresses: ['192.168.10.12'], allows: () => true };
  const app = createHttpApp({ localSessionScope: scope });
  const warnings = [];
  const http = lan.createLanHttpListeners({
    port: 0,
    scope,
    hostPreference: '203.0.113.5',
    primaryServer: app,
    requestListener: app.requestListener,
    createServer: () => new FakeServer(),
    log: (message) => warnings.push(message),
  });
  t.after(() => http.close());
  await http.start();
  await http.reconcile();
  assert.deepEqual(
    http.addresses().map((row) => row.host),
    ['127.0.0.1', '::1'],
  );
  assert.equal(warnings.filter((line) => line.includes('203.0.113.5')).length, 1);
});

function get(port, agent) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path: '/api/info', agent },
      (response) => {
        response.resume();
        response.on('end', () => resolve({ status: response.statusCode, socket }));
      },
    );
    let socket;
    request.on('socket', (value) => (socket = value));
    request.on('error', reject);
    request.end();
  });
}

test('a prior keep-alive socket cannot make a request after its peer loses local eligibility', async (t) => {
  let eligible = true;
  const scope = { bindAddresses: [], allows: () => eligible };
  const app = createHttpApp({ localSessionScope: scope });
  const http = lan.createLanHttpListeners({
    port: 0,
    scope,
    hostPreference: '127.0.0.1',
    primaryServer: app,
    requestListener: app.requestListener,
  });
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  t.after(() => http.close());
  await http.start();
  const port = http.addresses().find((row) => row.host === '127.0.0.1').port;
  const first = await get(port, agent);
  assert.equal(first.status, 200);
  eligible = false;
  const second = await get(port, agent);
  assert.equal(second.socket, first.socket);
  assert.equal(second.status, 403);
});
