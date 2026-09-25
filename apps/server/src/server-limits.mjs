import { isIP } from 'node:net';
import { plainAddress } from './peer-network.mjs';

// Connection limits every HTTP(S) listener of this product carries. They live in one
// place so the plaintext and TLS listeners cannot drift apart: an https server built with
// Node's defaults would accept slow or idle clients for minutes and without a connection
// cap, quietly weakening exactly the hardening the plaintext listener already has.
//
// `maxConnectionsPerSource` stops one machine holding every one of the `maxConnections`
// slots with slow requests and so locking everyone else out. A browser opens up to six
// connections to one server, so the cap leaves room for a second tab. IPv6 sources are
// grouped by /64, the smallest block an ISP gives a customer. Loopback is exempt: it is this
// PC.
export const SERVER_LIMITS = Object.freeze({
  requestTimeout: 15000,
  headersTimeout: 10000,
  maxConnections: 32,
  maxConnectionsPerSource: 12,
});

export function connectionSource(address) {
  const plain = plainAddress(address);
  if (isIP(plain) !== 6) return plain;
  const [head, tail] = plain.toLowerCase().split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const words = plain.includes('::')
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return `${words
    .slice(0, 4)
    .map((word) => word.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

export function applyServerLimits(server) {
  server.requestTimeout = SERVER_LIMITS.requestTimeout;
  server.headersTimeout = SERVER_LIMITS.headersTimeout;
  server.maxConnections = SERVER_LIMITS.maxConnections;
  const open = new Map();
  server.on('connection', (socket) => {
    const address = plainAddress(socket.remoteAddress);
    if (!address || address === '::1' || address.startsWith('127.')) return;
    const source = connectionSource(address);
    const count = open.get(source) ?? 0;
    if (count >= SERVER_LIMITS.maxConnectionsPerSource) {
      socket.destroy();
      return;
    }
    open.set(source, count + 1);
    socket.once('close', () => {
      const left = open.get(source) - 1;
      if (left > 0) open.set(source, left);
      else open.delete(source);
    });
  });
  return server;
}
