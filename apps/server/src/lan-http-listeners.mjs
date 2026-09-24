import { createServer as createHttpServer } from 'node:http';
import { isIP } from 'node:net';
import { applyServerLimits } from './server-limits.mjs';

function privateHostAddress(address) {
  if (typeof address !== 'string' || address.includes('%')) return false;
  const family = isIP(address);
  if (family === 4) {
    const [first, second] = address.split('.').map(Number);
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }
  return family === 6 && /^f[cd][0-9a-f]{2}:/i.test(address);
}

function normalizedPreference(value) {
  if (typeof value !== 'string') return '0.0.0.0';
  const trimmed = value.trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

export function desiredHttpAddresses(scope, hostPreference = '0.0.0.0') {
  const preference = normalizedPreference(hostPreference);
  const eligible = [...new Set((scope?.bindAddresses ?? []).filter(privateHostAddress))];
  const permitted = ['0.0.0.0', '::'].includes(preference)
    ? eligible
    : eligible.filter((address) => address === preference);
  return ['127.0.0.1', '::1', ...permitted];
}

export function createLanHttpListeners({
  port,
  scope,
  hostPreference = '0.0.0.0',
  primaryServer,
  requestListener,
  createServer = createHttpServer,
  log = () => {},
}) {
  if (!primaryServer || typeof requestListener !== 'function')
    throw new Error('LAN HTTP requires its primary server and request handler');
  const bound = new Map();
  let queue = Promise.resolve();
  let started = false;
  let closed = false;
  let warnedPreference = null;

  const enqueue = (operation) => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };

  async function stopHost(host) {
    const server = bound.get(host);
    if (!server) return;
    bound.delete(host);
    const finished = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    await finished;
  }

  async function bindHost(host, required) {
    const server = host === '127.0.0.1' ? primaryServer : createServer(requestListener);
    if (server !== primaryServer) applyServerLimits(server);
    server.prependListener('connection', (socket) => {
      try {
        if (!scope.allows(socket.remoteAddress, 'local')) socket.destroy();
      } catch {
        socket.destroy();
      }
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        try {
          server.listen(port, host, () => {
            server.off('error', reject);
            resolve();
          });
        } catch (error) {
          server.off('error', reject);
          reject(error);
        }
      });
      bound.set(host, server);
    } catch (error) {
      if (required) throw error;
      log(`Warning: local HTTP could not bind ${host}: ${error.message}`);
    }
  }

  async function synchronize() {
    if (closed) return;
    const wanted = desiredHttpAddresses(scope, hostPreference);
    const preference = normalizedPreference(hostPreference);
    if (
      !['0.0.0.0', '::', '127.0.0.1', '::1', 'localhost'].includes(preference) &&
      !wanted.includes(preference) &&
      warnedPreference !== preference
    ) {
      log(
        `Warning: HTTP bind preference ${preference} is not an eligible Private LAN address; HTTP is loopback-only.`,
      );
      warnedPreference = preference;
    }
    if (!bound.has('127.0.0.1')) await bindHost('127.0.0.1', true);
    for (const host of [...bound.keys()]) if (!wanted.includes(host)) await stopHost(host);
    for (const host of wanted) if (!bound.has(host)) await bindHost(host, false);
  }

  return {
    start() {
      if (closed) throw new Error('LAN HTTP listeners are closed');
      if (started) return this.reconcile();
      started = true;
      return enqueue(synchronize);
    },
    reconcile() {
      if (!started) throw new Error('LAN HTTP listeners have not started');
      return enqueue(synchronize);
    },
    close() {
      closed = true;
      return enqueue(async () => {
        for (const host of [...bound.keys()]) await stopHost(host);
      });
    },
    addresses() {
      return [...bound].map(([host, server]) => ({ host, port: server.address().port }));
    },
  };
}
