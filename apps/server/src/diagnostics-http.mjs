import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { applyServerLimits } from './server-limits.mjs';
import { isAllowedOrigin } from './tls/origin.mjs';

const ASSETS = new Set([
  '/diagnostics.js',
  '/diagnostics-auth.js',
  '/diagnostics.css',
  '/codec-preferences.js',
  '/profile-labels.js',
  '/latency-report.js',
]);

function send(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

const LATENCY_PROBE_ROUTE = '/api/diagnostics/latency-probe';
const LATENCY_PROBE_LIMIT = 1024;

async function readSmallJson(request, limit) {
  if (Number(request.headers['content-length']) > limit) {
    request.resume();
    throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  let size = 0;
  let text = '';
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Request too large'), { status: 413 });
    text += chunk;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
}

export function createDiagnosticsHttp({
  diagnostics,
  diagnosticsCapabilities,
  runtime,
  latencyProbes = null,
} = {}) {
  const authorized = (request) => {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '');
    return Boolean(match && diagnosticsCapabilities?.allows(match[1]));
  };
  const server = createServer(async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    );
    try {
      const host = new URL(`http://${request.headers.host}`).hostname;
      if (
        request.socket.remoteAddress !== '127.0.0.1' ||
        !['127.0.0.1', 'localhost'].includes(host) ||
        !isAllowedOrigin('http', request.headers.host, request.headers.origin)
      )
        return send(response, 403, { error: 'Diagnostics are available on this PC only.' });
      const route = new URL(request.url, 'http://localhost').pathname;
      if (route === LATENCY_PROBE_ROUTE && latencyProbes && runtime) {
        if (request.method !== 'POST') return send(response, 405, { error: 'POST required' });
        // The listener's only state-changing route: a same-origin page must say so.
        if (!request.headers.origin || !authorized(request)) {
          request.resume();
          return send(response, 403, { error: 'Diagnostics authorization required.' });
        }
        let body;
        try {
          body = await readSmallJson(request, LATENCY_PROBE_LIMIT);
        } catch (error) {
          return send(response, error.status, { error: error.message });
        }
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).join() !== 'streamId' ||
          typeof body.streamId !== 'string'
        )
          return send(response, 400, { error: 'Expected {streamId}' });
        const stream = runtime.registry.subscription(body.streamId);
        if (stream?.kind !== 'video' || stream.state !== 'live')
          return send(response, 404, { error: 'Unknown stream' });
        try {
          return send(response, 202, latencyProbes.request(body.streamId, stream.sessionId));
        } catch (error) {
          if (error.code === 'busy') return send(response, 409, { error: error.message });
          throw error;
        }
      }
      if (route !== '/diagnostics' && route !== '/api/diagnostics' && !ASSETS.has(route))
        return send(response, 404, { error: 'Not found' });
      if (request.method !== 'GET') return send(response, 405, { error: 'GET required' });
      if (route === '/api/diagnostics') {
        if (!authorized(request))
          return send(response, 403, { error: 'Diagnostics authorization required.' });
        if (!runtime) return send(response, 200, diagnostics?.snapshot() || {});
        const streams = runtime.diagnosticStreams();
        const selectedStreamId =
          new URL(request.url, 'http://localhost').searchParams.get('stream') ??
          streams[0]?.id ??
          null;
        return send(response, 200, {
          ...(runtime.diagnostics(selectedStreamId) ?? { at: Date.now(), history: [] }),
          streams,
          selectedStreamId,
          ...(latencyProbes ? { latencyProbe: latencyProbes.snapshot(selectedStreamId) } : {}),
        });
      }
      const file = route === '/diagnostics' ? 'diagnostics.html' : route.slice(1);
      const body = await readFile(new URL(import.meta.resolve(`@vidvnc/web-client/${file}`)));
      response.writeHead(200, {
        'content-type': file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : 'text/html',
        'cache-control': 'no-store',
      });
      response.end(body);
    } catch {
      if (!response.headersSent) send(response, 500, { error: 'Diagnostics unavailable' });
    }
  });
  applyServerLimits(server);
  return server;
}

export function diagnosticsUrl(server) {
  const address = server.address();
  if (!address || typeof address === 'string' || address.address !== '127.0.0.1')
    throw new Error('Private diagnostics listener is unavailable');
  return `http://127.0.0.1:${address.port}/diagnostics`;
}
