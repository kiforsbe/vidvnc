import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RelayCore, validateAllow } from '../src/media-relay/relay.mjs';
import { bindingRequest, bindingResponse } from './fixtures/stun-messages.mjs';

// An in-memory network: sockets bound to (address, port) deliver to each other, and every
// datagram the relay's public socket sends is recorded.
class FakeNet {
  sockets = new Map();
  nextPort = 50000;
  failUdp6 = null;
  createSocket = (options) => new FakeSocket(this, options);
}

class FakeSocket extends EventEmitter {
  constructor(net, options) {
    super();
    this.net = net;
    this.options = options;
    this.sent = [];
  }
  bind(port, address, callback) {
    if (this.options.type === 'udp6' && this.net.failUdp6) {
      queueMicrotask(() => this.emit('error', this.net.failUdp6));
      return;
    }
    this.port = port || this.net.nextPort++;
    this.boundAddress = address;
    this.net.sockets.set(`${address}|${this.port}`, this);
    queueMicrotask(callback);
  }
  send(message, port, address) {
    this.sent.push({ message, port, address });
    const target = this.net.sockets.get(`${address}|${port}`);
    target?.emit('message', message, { address: this.boundAddress, port: this.port });
  }
  close() {
    this.net.sockets.delete(`${this.boundAddress}|${this.port}`);
    this.closed = true;
  }
}

const UFRAG = 'wKr1';
const PWD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CLIENT_UFRAG = 'Cli3';
const CLIENT_PWD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const WORKER_PORT = 49152;
const CLIENT = { address: '::ffff:203.0.113.9', port: 53122 };

async function setup({ limits = {}, clientHint = '203.0.113.9', now } = {}) {
  const net = new FakeNet();
  const events = [];
  let clock = 1_000_000;
  const relay = new RelayCore({
    createSocket: net.createSocket,
    now: now ?? (() => clock),
    onEvent: (event) => events.push(event),
    limits,
  });
  await relay.start(4384);
  const publicSocket = net.sockets.get('::|4384');
  const worker = net.createSocket({ type: 'udp4' });
  await new Promise((resolve) => worker.bind(WORKER_PORT, '127.0.0.1', resolve));
  const received = [];
  worker.on('message', (message, from) => received.push({ message, from }));
  relay.allow({
    streamId: 'stream-1',
    ufrag: UFRAG,
    pwd: PWD,
    clientUfrag: CLIENT_UFRAG,
    clientPwd: CLIENT_PWD,
    workerPort: WORKER_PORT,
    clientHint,
    expiresMs: 15000,
  });
  const tick = async () => new Promise((resolve) => setImmediate(resolve));
  return {
    net,
    relay,
    events,
    publicSocket,
    worker,
    received,
    tick,
    advance: (ms) => (clock += ms),
  };
}

test('strangers get nothing: malformed datagrams are dropped without any reply', async () => {
  const { relay, publicSocket, received, tick } = await setup();
  relay.receive(Buffer.from('hello'), CLIENT);
  relay.receive(Buffer.from([22, 254, 253, 0, 0]), CLIENT); // DTLS before authentication
  await tick();
  assert.equal(received.length, 0);
  assert.equal(publicSocket.sent.length, 0);
  assert.equal(relay.metrics().dropped.malformed, 2);
});

test('a check with the session password pins the tuple and reaches the worker', async () => {
  const { relay, events, received, worker, publicSocket, tick } = await setup();
  const check = bindingRequest(`${UFRAG}:${CLIENT_UFRAG}`, PWD);
  relay.receive(check, CLIENT);
  await tick();
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].message, check);
  assert.equal(received[0].from.address, '127.0.0.1');
  assert.deepEqual(events[0], {
    type: 'pinned',
    streamId: 'stream-1',
    tuple: '203.0.113.9:53122',
    hintMatched: true,
  });
  // The worker's reply goes back to the client's tuple through the public socket.
  worker.send(Buffer.from([1, 1, 0, 0]), received[0].from.port, '127.0.0.1');
  assert.equal(publicSocket.sent.length, 1);
  assert.equal(publicSocket.sent[0].address, CLIENT.address);
  assert.equal(publicSocket.sent[0].port, CLIENT.port);
});

test('a wrong password, an unknown ufrag or a foreign sender ufrag pins nothing', async () => {
  const { relay, received, tick } = await setup();
  relay.receive(bindingRequest(`${UFRAG}:${CLIENT_UFRAG}`, 'x'.repeat(30)), CLIENT);
  relay.receive(bindingRequest(`nope:${CLIENT_UFRAG}`, PWD), CLIENT);
  relay.receive(bindingRequest(`${UFRAG}:Evil`, PWD), CLIENT);
  await tick();
  assert.equal(received.length, 0);
  const { dropped, pins } = relay.metrics();
  assert.equal(dropped['bad-integrity'], 1);
  assert.equal(dropped['unknown-ufrag'], 1);
  assert.equal(dropped.username, 1);
  assert.equal(pins, 0);
});

test('on an authenticated path STUN is re-verified and other bytes are filtered by class', async () => {
  const { relay, received, tick } = await setup();
  relay.allow({
    streamId: 'stream-2',
    ufrag: 'othr',
    pwd: 'c'.repeat(30),
    clientUfrag: 'Cli4',
    clientPwd: 'd'.repeat(30),
    workerPort: 49153,
    clientHint: null,
    expiresMs: 15000,
  });
  relay.receive(bindingRequest(`${UFRAG}:${CLIENT_UFRAG}`, PWD), CLIENT);
  await tick();
  const forwarded = () => received.length;
  const before = forwarded();

  relay.receive(Buffer.from([22, 254, 253, 1, 2, 3]), CLIENT); // DTLS: forwarded
  relay.receive(Buffer.from([0x80, 0x60, 0, 1]), CLIENT); // RTP: forwarded
  relay.receive(bindingResponse(CLIENT_PWD), CLIENT); // answer to the worker's check
  relay.receive(bindingRequest(`${UFRAG}:${CLIENT_UFRAG}`, PWD), CLIENT); // consent check
  await tick();
  assert.equal(forwarded() - before, 4);

  relay.receive(Buffer.from([70, 1, 2, 3]), CLIENT); // TURN channel range: not WebRTC here
  relay.receive(bindingResponse('e'.repeat(30)), CLIENT); // response with the wrong key
  relay.receive(bindingRequest(`othr:Cli4`, 'c'.repeat(30)), CLIENT); // another stream's check
  relay.receive(bindingRequest(`${UFRAG}:${CLIENT_UFRAG}`, 'f'.repeat(30)), CLIENT);
  await tick();
  assert.equal(forwarded() - before, 4);
  const { dropped } = relay.metrics();
  assert.equal(dropped.class, 1);
  assert.equal(dropped['bad-integrity'], 2);
  assert.equal(dropped['cross-registration'], 1);
});

test('a pin socket accepts datagrams only from the worker port', async () => {
  const { relay, net, received, publicSocket, tick } = await setup();
  relay.receive(bindingRequest(`${UFRAG}:${CLIENT_UFRAG}`, PWD), CLIENT);
  await tick();
  const pinPort = received[0].from.port;
  const intruder = net.createSocket({ type: 'udp4' });
  await new Promise((resolve) => intruder.bind(0, '127.0.0.1', resolve));
  intruder.send(Buffer.from([22, 1]), pinPort, '127.0.0.1');
  assert.equal(publicSocket.sent.length, 0);
  assert.equal(relay.metrics().dropped['loopback-source'], 1);
});

test('a forged-source flood exhausts only the strangers’ lane, not a known client', async () => {
  const { relay, received, tick } = await setup({
    limits: { strangerPerSource: 3, strangerTotal: 5, hintLanePerSecond: 10 },
  });
  for (let i = 0; i < 100; i++)
    relay.receive(Buffer.from('garbage'), { address: `198.51.100.${i}`, port: 1000 + i });
  assert.equal(relay.metrics().dropped.budget, 95);
  relay.receive(bindingRequest(`${UFRAG}:${CLIENT_UFRAG}`, PWD), CLIENT);
  await tick();
  assert.equal(received.length, 1, 'the client whose address is known still connects');
});

test('a different media address is counted and reported once, but still pinned', async () => {
  const { relay, events, received, tick } = await setup({ clientHint: '17.253.1.1' });
  relay.receive(bindingRequest(`${UFRAG}:${CLIENT_UFRAG}`, PWD), CLIENT);
  relay.receive(bindingRequest(`${UFRAG}:${CLIENT_UFRAG}`, PWD), {
    address: '::ffff:203.0.113.9',
    port: 53123,
  });
  await tick();
  assert.equal(received.length, 2);
  assert.equal(relay.metrics().addressDiffers, 2);
  assert.equal(events.filter((event) => event.type === 'address-differs').length, 1);
  assert.equal(events.find((event) => event.type === 'pinned').hintMatched, false);
});

test('registrations sharing a ufrag are told apart by their passwords', async () => {
  const { relay, received, events, tick } = await setup();
  relay.allow({
    streamId: 'stream-2',
    ufrag: UFRAG,
    pwd: 'g'.repeat(30),
    clientUfrag: 'Cli5',
    clientPwd: 'h'.repeat(30),
    workerPort: 49160,
    clientHint: null,
    expiresMs: 15000,
  });
  relay.receive(bindingRequest(`${UFRAG}:Cli5`, 'g'.repeat(30)), {
    address: '198.51.100.7',
    port: 4000,
  });
  await tick();
  assert.equal(received.length, 0, 'not delivered to stream-1’s worker');
  assert.equal(events[0].streamId, 'stream-2');
});

test('unused registrations expire, quiet pins end, and revoke closes everything', async () => {
  const { relay, events, received, advance, tick } = await setup();
  relay.allow({
    streamId: 'stream-2',
    ufrag: 'othr',
    pwd: 'c'.repeat(30),
    clientUfrag: 'Cli4',
    clientPwd: 'd'.repeat(30),
    workerPort: 49153,
    clientHint: null,
    expiresMs: 5000,
  });
  relay.receive(bindingRequest(`${UFRAG}:${CLIENT_UFRAG}`, PWD), CLIENT);
  await tick();
  advance(6000);
  relay.sweep();
  assert.ok(events.some((event) => event.type === 'expired' && event.streamId === 'stream-2'));
  assert.equal(relay.metrics().registrations, 1, 'a pinned registration does not expire');
  advance(30_000);
  relay.sweep();
  assert.ok(events.some((event) => event.type === 'unpinned' && event.reason === 'idle'));
  assert.equal(relay.metrics().pins, 0);
  // Re-authenticating after the pin ended works; after revoke it does not.
  relay.receive(bindingRequest(`${UFRAG}:${CLIENT_UFRAG}`, PWD), CLIENT);
  await tick();
  assert.equal(relay.metrics().pins, 1);
  assert.equal(relay.revoke('stream-1'), true);
  assert.equal(relay.metrics().pins, 0);
  const count = received.length;
  relay.receive(Buffer.from([22, 254, 253]), CLIENT);
  await tick();
  assert.equal(received.length, count);
});

test('at most four tuples pin per registration', async () => {
  const { relay, tick } = await setup({ clientHint: null });
  for (let port = 1; port <= 6; port++)
    relay.receive(bindingRequest(`${UFRAG}:${CLIENT_UFRAG}`, PWD), {
      address: '198.51.100.9',
      port,
    });
  await tick();
  assert.equal(relay.metrics().pins, 4);
  assert.equal(relay.metrics().dropped.pins, 2);
});

test('registrations are validated and bounded', async () => {
  const valid = {
    streamId: 'a-1',
    ufrag: 'abcd',
    pwd: 'p'.repeat(22),
    clientUfrag: 'efgh',
    clientPwd: 'q'.repeat(22),
    workerPort: 50000,
    clientHint: '::ffff:192.0.2.1',
    expiresMs: 15000,
  };
  assert.deepEqual(validateAllow(valid), valid);
  for (const change of [
    { streamId: '' },
    { streamId: 'x'.repeat(65) },
    { ufrag: 'abc' },
    { ufrag: 'ab:c' },
    { pwd: 'p'.repeat(21) },
    { clientPwd: 'q'.repeat(257) },
    { workerPort: 80 },
    { workerPort: 50000.5 },
    { clientHint: 'not-an-address' },
    { expiresMs: 15001 },
    { expiresMs: 0 },
  ])
    assert.throws(() => validateAllow({ ...valid, ...change }), JSON.stringify(change));

  const { relay } = await setup({ limits: { registrations: 2, perUfrag: 1 } });
  assert.throws(() => relay.allow({ ...valid, streamId: 'stream-1' }), /Duplicate/);
  assert.throws(() => relay.allow({ ...valid, ufrag: 'wKr1' }), /share this ufrag/);
  relay.allow(valid);
  assert.throws(() => relay.allow({ ...valid, streamId: 'a-2', ufrag: 'zzzz' }), /limit/);
});

test('the public port binds dual-stack, falls back to IPv4, and reports a port in use', async () => {
  const net = new FakeNet();
  const dual = new RelayCore({ createSocket: net.createSocket });
  assert.deepEqual(await dual.start(4384), { port: 4384, families: ['ipv6', 'ipv4'] });
  assert.equal(net.sockets.get('::|4384').options.ipv6Only, false);

  const noIpv6 = new FakeNet();
  noIpv6.failUdp6 = Object.assign(new Error('no IPv6'), { code: 'EAFNOSUPPORT' });
  const fallback = new RelayCore({ createSocket: noIpv6.createSocket });
  assert.deepEqual(await fallback.start(4384), { port: 4384, families: ['ipv4'] });

  const busy = new FakeNet();
  busy.failUdp6 = Object.assign(new Error('in use'), { code: 'EADDRINUSE' });
  await assert.rejects(new RelayCore({ createSocket: busy.createSocket }).start(4384), /in use/);
  await assert.rejects(dual.start(80), /Invalid port/);
});

test('with real UDP sockets on loopback, an authenticated client reaches the worker and back', async () => {
  const { createSocket } = await import('node:dgram');
  const once = (socket, event) =>
    new Promise((resolve) => socket.once(event, (...args) => resolve(args)));
  const bound = async (socket, port, address) => {
    socket.bind(port, address);
    await once(socket, 'listening');
    return socket.address().port;
  };
  // A free port for the relay: bind, read, release.
  const probe = createSocket('udp4');
  const port = await bound(probe, 0, '127.0.0.1');
  probe.close();

  const relay = new RelayCore({ createSocket: (options) => createSocket(options) });
  await relay.start(port);
  const worker = createSocket('udp4');
  const workerPort = await bound(worker, 0, '127.0.0.1');
  const client = createSocket('udp4');
  await bound(client, 0, '127.0.0.1');
  try {
    relay.allow({
      streamId: 'real-1',
      ufrag: UFRAG,
      pwd: PWD,
      clientUfrag: CLIENT_UFRAG,
      clientPwd: CLIENT_PWD,
      workerPort,
      clientHint: '127.0.0.1',
      expiresMs: 15000,
    });
    const check = bindingRequest(`${UFRAG}:${CLIENT_UFRAG}`, PWD);
    client.send(check, port, '127.0.0.1');
    const [atWorker, from] = await once(worker, 'message');
    assert.deepEqual(atWorker, check);
    assert.equal(from.address, '127.0.0.1');
    worker.send(Buffer.from([22, 254, 253, 9]), from.port, '127.0.0.1');
    const [atClient, reply] = await once(client, 'message');
    assert.deepEqual(atClient, Buffer.from([22, 254, 253, 9]));
    assert.equal(reply.port, port);
  } finally {
    relay.close();
    worker.close();
    client.close();
  }
});
