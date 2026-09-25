import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { applyServerLimits, connectionSource, SERVER_LIMITS } from '../src/server-limits.mjs';

function fakeSocket(remoteAddress) {
  const socket = new EventEmitter();
  socket.remoteAddress = remoteAddress;
  socket.destroyed = false;
  socket.destroy = () => {
    socket.destroyed = true;
  };
  return socket;
}

test('groups IPv6 sources by /64 and IPv4-mapped sources by their IPv4 address', () => {
  assert.equal(connectionSource('::ffff:192.0.2.7'), '192.0.2.7');
  assert.equal(connectionSource('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(connectionSource('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
});

test('one source cannot hold more than its share of connections, and closing frees a slot', () => {
  const server = applyServerLimits(new EventEmitter());
  const limit = SERVER_LIMITS.maxConnectionsPerSource;
  const held = Array.from({ length: limit }, () => fakeSocket('203.0.113.9'));
  for (const socket of held) server.emit('connection', socket);
  assert.equal(
    held.some((socket) => socket.destroyed),
    false,
  );
  const extra = fakeSocket('::ffff:203.0.113.9');
  server.emit('connection', extra);
  assert.equal(extra.destroyed, true);
  const other = fakeSocket('198.51.100.1');
  server.emit('connection', other);
  assert.equal(other.destroyed, false, 'another source is unaffected');
  held[0].emit('close');
  const next = fakeSocket('203.0.113.9');
  server.emit('connection', next);
  assert.equal(next.destroyed, false);
});

test('this PC is never capped', () => {
  const server = applyServerLimits(new EventEmitter());
  for (let i = 0; i < SERVER_LIMITS.maxConnectionsPerSource + 5; i++) {
    const socket = fakeSocket(i % 2 ? '127.0.0.1' : '::1');
    server.emit('connection', socket);
    assert.equal(socket.destroyed, false);
  }
});
