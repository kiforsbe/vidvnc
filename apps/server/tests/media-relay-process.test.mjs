import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runRelay } from '../src/media-relay/protocol.mjs';
import { MediaRelay } from '../src/media-relay.mjs';
import { bindingRequest } from './fixtures/stun-messages.mjs';

const REGISTRATION = {
  streamId: 'stream-1',
  ufrag: 'wKr1',
  pwd: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  clientUfrag: 'Cli3',
  clientPwd: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  workerPort: 49152,
  clientHint: '127.0.0.1',
  expiresMs: 15000,
};

const lines = (stream) => {
  const out = [];
  let buffered = '';
  stream.on('data', (data) => {
    buffered += String(data);
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      out.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  });
  return out;
};

const until = async (predicate, ms = 3000) => {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

async function freeUdpPort() {
  const socket = dgram.createSocket('udp4');
  await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

function protocol() {
  const input = new PassThrough();
  const output = new PassThrough();
  const errors = new PassThrough();
  const replies = lines(output);
  let exitCode = null;
  const sockets = [];
  const createSocket = () => {
    const socket = new EventEmitter();
    socket.bind = (port, address, callback) => queueMicrotask(callback);
    socket.send = () => {};
    socket.close = () => (socket.closed = true);
    sockets.push(socket);
    return socket;
  };
  runRelay({ input, output, errors, createSocket, exit: (code) => (exitCode = code) });
  const send = (message) => input.write(`${JSON.stringify(message)}\n`);
  return { input, replies, send, sockets, exitCode: () => exitCode };
}

test('the relay protocol starts, allows, refuses a duplicate and stops', async () => {
  const relay = protocol();
  relay.send({ type: 'start', port: 4384 });
  await until(() => relay.replies.some((reply) => reply.type === 'ready'));
  relay.send({ type: 'allow', ...REGISTRATION });
  relay.send({ type: 'allow', ...REGISTRATION });
  await until(() => relay.replies.length >= 3);
  assert.deepEqual(relay.replies.slice(1, 3), [
    { type: 'allowed', streamId: 'stream-1' },
    { type: 'refused', streamId: 'stream-1', reason: 'Duplicate relay registration' },
  ]);
  relay.send({ type: 'revoke', streamId: 'stream-1' });
  relay.send({ type: 'stop' });
  await until(() => relay.exitCode() !== null);
  assert.equal(relay.exitCode(), 0);
  assert.ok(relay.sockets[0].closed);
});

test('the relay protocol fails closed on anything unexpected', async () => {
  const cases = [
    (relay) => relay.send({ type: 'allow', ...REGISTRATION }), // before start
    (relay) => relay.input.write('not json\n'),
    (relay) => relay.input.write(`${'x'.repeat(5000)}`),
    (relay) => {
      relay.send({ type: 'start', port: 4384 });
      relay.send({ type: 'allow', ...REGISTRATION, workerPort: 80 });
    },
    (relay) => {
      relay.send({ type: 'start', port: 4384 });
      relay.send({ type: 'shell', command: 'x' });
    },
  ];
  for (const [index, act] of cases.entries()) {
    const relay = protocol();
    act(relay);
    await until(() => relay.exitCode() !== null);
    assert.equal(relay.exitCode(), 2, `case ${index}`);
    assert.ok(!relay.replies.some((reply) => reply.type === 'allowed'), `case ${index}`);
  }
});

test('the relay protocol ends when its input closes', async () => {
  const relay = protocol();
  relay.send({ type: 'start', port: 4384 });
  await until(() => relay.replies.length === 1);
  relay.input.end();
  await until(() => relay.exitCode() !== null);
  assert.equal(relay.exitCode(), 0);
});

test('a real relay process forwards an authenticated check to the worker port', async () => {
  const port = await freeUdpPort();
  const worker = dgram.createSocket('udp4');
  await new Promise((resolve) => worker.bind(0, '127.0.0.1', resolve));
  const received = [];
  worker.on('message', (message, from) => received.push({ message, from }));
  const events = [];
  const relay = new MediaRelay({ port: () => port, onEvent: (event) => events.push(event) });
  await relay.start();
  assert.equal(relay.state, 'listening', relay.reason);
  await relay.allow({ ...REGISTRATION, workerPort: worker.address().port });

  const client = dgram.createSocket('udp4');
  await new Promise((resolve) => client.bind(0, '127.0.0.1', resolve));
  client.send(bindingRequest('wKr1:Cli3', 'cccccccccccccccccccccccccccccc'), port, '127.0.0.1');
  client.send(bindingRequest('wKr1:Cli3', REGISTRATION.pwd), port, '127.0.0.1');
  await until(() => received.length === 1 && events.some((event) => event.type === 'pinned'));
  assert.equal(received[0].from.address, '127.0.0.1');
  assert.notEqual(received[0].from.port, client.address().port);

  // The worker's reply goes back to the client from the media port.
  const back = new Promise((resolve) => client.once('message', (message, from) => resolve(from)));
  worker.send(Buffer.from([0x80, 0x60, 0, 1]), received[0].from.port, '127.0.0.1');
  assert.equal((await back).port, port);

  await until(() => relay.metrics?.dropped?.['bad-integrity'] === 1, 5000);
  await relay.stop();
  assert.equal(relay.state, 'stopped');
  client.close();
  worker.close();
});

test('a port in use leaves media unavailable with the reason', async () => {
  const holder = dgram.createSocket({ type: 'udp6', ipv6Only: false });
  const bound = await new Promise((resolve) => {
    holder.once('error', () => resolve(false));
    holder.bind(0, '::', () => resolve(true));
  });
  const blocker = bound ? holder : dgram.createSocket('udp4');
  if (!bound) await new Promise((resolve) => blocker.bind(0, '0.0.0.0', resolve));
  const port = blocker.address().port;
  const logged = [];
  const relay = new MediaRelay({ port: () => port, log: (line) => logged.push(line) });
  await relay.start();
  assert.equal(relay.state, 'unavailable');
  assert.match(relay.reason, new RegExp(`UDP ${port} is in use`));
  await assert.rejects(relay.allow(REGISTRATION), /Media is unavailable/);
  blocker.close();
});

// A child process double that answers `start` and can be made to exit.
function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const commands = lines(child.stdin);
  child.kill = () => child.emit('exit', null, 'SIGTERM');
  child.stdin.on('data', () =>
    queueMicrotask(() => {
      const last = commands.at(-1);
      if (last?.type === 'start')
        child.stdout.write(
          `${JSON.stringify({ type: 'ready', port: last.port, families: ['ipv4'] })}\n`,
        );
      if (last?.type === 'stop') child.emit('exit', 0, null);
    }),
  );
  child.commands = commands;
  return child;
}

test('an exiting relay stops every stream and restarts at most three times a minute', async () => {
  const children = [];
  let clock = 0;
  let exits = 0;
  const relay = new MediaRelay({
    port: () => 4384,
    now: () => clock,
    onExit: () => exits++,
    launch: () => {
      const child = fakeChild();
      children.push(child);
      return child;
    },
  });
  await relay.start();
  assert.equal(relay.state, 'listening');
  const pending = assert.rejects(relay.allow(REGISTRATION), /stopped/);
  for (let round = 1; round <= 3; round++) {
    children.at(-1).emit('exit', 1, null);
    await until(() => relay.state === 'listening' && children.length === round + 1);
  }
  await pending;
  assert.equal(exits, 3);
  children.at(-1).emit('exit', 1, null);
  assert.equal(relay.state, 'unavailable');
  assert.equal(exits, 4);
  assert.equal(children.length, 4);

  // A minute later a restart is allowed again (after the owner restarts VidVNC or the port
  // changes, `restart` resets the budget).
  clock += 61_000;
  await relay.restart();
  assert.equal(relay.state, 'listening');
});

test('allow times out and revokes when the relay does not confirm', async () => {
  const child = fakeChild();
  const relay = new MediaRelay({ port: () => 4384, allowTimeoutMs: 20, launch: () => child });
  await relay.start();
  child.stdin.removeAllListeners('data');
  const commands = lines(child.stdin);
  await assert.rejects(relay.allow(REGISTRATION), /did not confirm/);
  assert.deepEqual(
    commands.map((command) => command.type),
    ['allow', 'revoke'],
  );
});
