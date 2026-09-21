// Connection limits every HTTP(S) listener of this product carries. They live in one
// place so the plaintext and TLS listeners cannot drift apart: an https server built with
// Node's defaults would accept slow or idle clients for minutes and without a connection
// cap, quietly weakening exactly the hardening the plaintext listener already has.
export const SERVER_LIMITS = Object.freeze({
  requestTimeout: 15000,
  headersTimeout: 10000,
  maxConnections: 32,
});

export function applyServerLimits(server) {
  server.requestTimeout = SERVER_LIMITS.requestTimeout;
  server.headersTimeout = SERVER_LIMITS.headersTimeout;
  server.maxConnections = SERVER_LIMITS.maxConnections;
  return server;
}
