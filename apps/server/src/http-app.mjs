import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { SessionStore } from './session-store.mjs';
import { chooseProfile, profileNames } from './profiles.mjs';
import { audioModes, chooseAudioMode } from './audio.mjs';
import { defaultStreamPolicy, resolveStreamPolicy } from './stream-policy.mjs';
import { applyProfileOrder } from './profile-order.mjs';
import { isAllowedOrigin } from './tls/origin.mjs';
import { applyServerLimits } from './server-limits.mjs';

function send(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}
// The three enrolment endpoints fixed by ruling before Task 11 exists to implement their
// handlers (see the plan's progress ledger, ruling R2). They stay reachable on the
// plaintext listener, unredirected, because a device that does not yet trust the host has
// no un-warned way to fetch the trust anchor over the very connection that anchor exists
// to authenticate. Every other plaintext request redirects to the HTTPS equivalent once
// TLS is active. Task 11 fills in the handlers at these exact paths; until then they fall
// through to the existing 404 catch-all below, same as any other unknown route.
export const PLAINTEXT_ALLOWED_PATHS = Object.freeze([
  '/trust',
  '/api/trust/anchor',
  '/api/trust/status',
]);

async function readJson(request) {
  let size = 0,
    text = '';
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 128 * 1024) throw Object.assign(new Error('Request too large'), { status: 413 });
    text += chunk;
  }
  let value;
  try {
    value = JSON.parse(text || '{}');
  } catch {
    throw Object.assign(new Error('Invalid JSON'), { status: 400 });
  }
  if (!value || Array.isArray(value) || typeof value !== 'object')
    throw Object.assign(new Error('Expected JSON object'), { status: 400 });
  return value;
}
export function createHttpApp({
  serverName = 'This PC',
  display = null,
  media = null,
  diagnostics = null,
  policy = null,
  inventory = null,
  profileOrderFile = null,
  runtime = null,
  sessionStore = new SessionStore(),
  approvedClients = null,
  access = null,
  // Injectable TLS status: `{ status() }` returning `{ active, port }`, read on every
  // request. Omitted, the app behaves as if TLS is inactive, which keeps every existing
  // caller (this app is constructed in dozens of tests with no `tls` option) byte-identical
  // to today: no redirect can ever fire unless a caller explicitly reports TLS as active.
  // main.mjs passes the TLS listener itself (tls/listener.mjs), whose `status()` is true
  // only while a listener is really bound. This function never provisions anything; it
  // only reads whatever status it is handed.
  tls = null,
} = {}) {
  const reconnecting = new Set();
  const telemetryTimes = new Map();
  const connectionMode = () => access?.snapshot().connectionMode ?? 'session-key';
  const ordinaryKeyAllowed = (purpose) =>
    (purpose === 'session' && connectionMode() === 'session-key') ||
    (purpose === 'one-time-connection' && connectionMode() !== 'approved-only');
  const allowedHosts = new Set([
    'localhost',
    '127.0.0.1',
    '[::1]',
    ...Object.values(networkInterfaces())
      .flat()
      .map((n) => n.address),
  ]);
  function connectionPlan(body, request) {
    let effective, selectedDisplay;
    if (inventory)
      selectedDisplay = inventory.select(policy.snapshot(), body.displayId, body.inventoryRevision);
    if (policy)
      effective = resolveStreamPolicy(policy.snapshot(), {
        profileId: typeof body.profile === 'string' ? body.profile : 'auto',
        displayId: selectedDisplay?.id,
        userAgent: request.headers['user-agent'] || '',
        custom: body.custom,
        audio: body.audio !== 'off',
      });
    return {
      effective,
      selectedDisplay,
      profile:
        effective?.profile ??
        chooseProfile(
          typeof body.profile === 'string' ? body.profile : 'auto',
          request.headers['user-agent'] || '',
        ),
      audio: chooseAudioMode(
        effective?.audio.mode ?? (typeof body.audio === 'string' ? body.audio : 'on'),
      ),
    };
  }
  function sendAdmission(response, result, plan) {
    if (!result.ok)
      return send(response, { busy: 409, 'rate-limited': 429 }[result.reason] || 401, {
        error:
          result.reason === 'busy'
            ? 'The server has reached its connected-device limit.'
            : 'Unable to authenticate. Try again later.',
      });
    sessionStore.setProfile(result.sessionId, plan.profile);
    sessionStore.setDisplay(result.sessionId, plan.selectedDisplay, inventory?.revision);
    if (plan.effective) sessionStore.setPolicyRevision(result.sessionId, plan.effective.revision);
    sessionStore.setAudio(result.sessionId, plan.audio);
    return send(response, 201, {
      sessionId: result.sessionId,
      mode: runtime ? 'streams' : undefined,
      controlEnabled: false,
      profile: plan.profile,
      audio: plan.audio,
      display: plan.selectedDisplay,
    });
  }
  const requestListener = async (request, response) => {
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const host = new URL(`http://${request.headers.host}`).hostname;
      if (!allowedHosts.has(host))
        return send(response, 403, { error: 'Use the server IP address.' });
      // The scheme is read from the socket, not from a client-supplied header (e.g.
      // X-Forwarded-Proto): only the connection itself can say whether it is encrypted.
      const scheme = request.socket.encrypted ? 'https' : 'http';
      const route = new URL(request.url, 'http://localhost').pathname;
      // Plaintext redirect: once TLS is active, every plaintext request except the
      // enrolment allow-list is sent to its HTTPS equivalent, preserving path and query
      // (`request.url` already carries both). 307 (not 301/302) so a non-GET request keeps
      // its method; it is deliberately not 308, which browsers cache permanently by
      // default — a cached redirect to the TLS port would keep sending a client there
      // after TLS is switched off or the port changes, so the response also says
      // `no-store`. The check runs AFTER the host allow-list above: the Location is built
      // from the already-allow-listed hostname and this listener's own TLS port, never
      // from the raw Host header, so it cannot be steered to another site. Only
      // origin-form targets ("/path?query") are redirected; anything else (an
      // absolute-form or authority-form request target) is not something the Location
      // could faithfully reproduce and falls through to normal handling. When `tls` is not
      // supplied, or reports `active: false` (no credential yet, or TLS off), this branch
      // never fires and every request is served exactly as it is today.
      if (scheme === 'http' && request.url.startsWith('/')) {
        const tlsStatus = tls?.status() ?? { active: false, port: null };
        if (tlsStatus.active && !PLAINTEXT_ALLOWED_PATHS.includes(route)) {
          response.writeHead(307, {
            location: `https://${host}:${tlsStatus.port}${request.url}`,
            'cache-control': 'no-store',
          });
          return response.end();
        }
      }
      if (!isAllowedOrigin(scheme, request.headers.host, request.headers.origin))
        return send(response, 403, { error: 'Cross-origin request denied' });
      if (route === '/diagnostics' || route === '/api/diagnostics') {
        const local =
          ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress) &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(host);
        if (!local)
          return send(response, 403, { error: 'Diagnostics are available on the server PC only.' });
        if (request.method !== 'GET') return send(response, 405, { error: 'GET required' });
        if (route === '/api/diagnostics') {
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
          });
        }
        response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
        return response.end(
          await readFile(new URL(import.meta.resolve('@vidvnc/web-client/diagnostics.html'))),
        );
      }
      if (
        request.method === 'GET' &&
        [
          '/',
          '/app.js',
          '/approved-client.js',
          '/password-entry.js',
          '/receiver-stats.js',
          '/stream-subscriptions.js',
          '/codec-preferences.js',
          '/profile-labels.js',
          '/diagnostics.js',
          '/diagnostics.css',
          '/style.css',
          '/theme.js',
          '/shell.css',
        ].includes(route)
      ) {
        const file = route === '/' ? 'index.html' : route.slice(1);
        const body = await readFile(new URL(import.meta.resolve(`@vidvnc/web-client/${file}`)));
        response.writeHead(200, {
          'content-type': file.endsWith('.js')
            ? 'text/javascript'
            : file.endsWith('.css')
              ? 'text/css'
              : 'text/html',
          'cache-control': 'no-store',
        });
        return response.end(body);
      }
      if (request.method === 'GET' && route === '/api/info')
        return send(response, 200, {
          serverName,
          display: null,
          profiles: profileNames(),
          audio: {
            modes: audioModes(),
            default: 'on',
            codec: 'Opus',
            compression: 'lossy',
            systemOutputOnly: true,
          },
          media: {
            state: media ? 'ready' : 'unavailable',
            codec: 'H.264 + Opus',
            transport: 'WebRTC',
          },
          control: { available: !!media },
          connectionMode: connectionMode(),
        });
      if (
        request.method !== 'POST' ||
        ![
          '/api/connect',
          '/api/connection-key',
          '/api/approved-clients/register',
          '/api/approved-clients/status',
          '/api/approved-clients/sign-in',
          '/api/offer',
          '/api/heartbeat',
          '/api/disconnect',
          '/api/telemetry',
          '/api/profiles',
          '/api/reconnect',
          '/api/streams',
          '/api/stream-offer',
          '/api/audio-offer',
          '/api/audio-telemetry',
          '/api/stream-stop',
          '/api/stream-select',
          '/api/stream-telemetry',
        ].includes(route)
      )
        return send(response, 404, { error: 'Not found' });
      if (!request.headers['content-type']?.startsWith('application/json'))
        return send(response, 415, { error: 'JSON required' });
      if (Number(request.headers['content-length']) > 128 * 1024) {
        request.resume();
        return send(response, 413, { error: 'Request too large' });
      }
      const body = await readJson(request);
      if (route === '/api/connection-key') {
        const record =
          typeof body.key === 'string' && body.key.length <= 64
            ? sessionStore.keys.inspect(body.key)
            : null;
        if (
          !record ||
          (record.purpose !== 'approved-client-setup' && !ordinaryKeyAllowed(record.purpose))
        )
          return send(response, 401, { error: 'Connection key is invalid or expired.' });
        return send(response, 200, {
          purpose: record.purpose,
          usage: record.usage,
          expiresAt: record.expiresAt,
        });
      }
      if (route === '/api/approved-clients/register') {
        if (!approvedClients)
          return send(response, 503, { error: 'Approved-client setup is unavailable.' });
        const record = sessionStore.keys.inspect(body.key);
        if (record?.purpose !== 'approved-client-setup')
          return send(response, 401, { error: 'Connection key is invalid or expired.' });
        try {
          return send(
            response,
            202,
            await approvedClients.submit({
              ...body,
              network: 'Local network',
            }),
          );
        } catch (error) {
          return send(response, /setup key/i.test(error.message) ? 401 : 400, {
            error: /setup key/i.test(error.message)
              ? 'Connection key is invalid or expired.'
              : error.message,
          });
        }
      }
      if (route === '/api/approved-clients/status') {
        if (!approvedClients)
          return send(response, 503, { error: 'Approved-client setup is unavailable.' });
        const result = approvedClients.registrationStatus(body.requestId, body.claimToken);
        return result.state === 'invalid'
          ? send(response, 401, { error: 'Registration request is invalid or expired.' })
          : send(response, 200, result);
      }
      if (route === '/api/approved-clients/sign-in') {
        if (!approvedClients)
          return send(response, 503, { error: 'Approved-client sign-in is unavailable.' });
        if (policy?.busy)
          return send(response, 409, { error: 'Host settings are being applied. Retry shortly.' });
        const approved = await approvedClients.authenticate(body, request.socket.remoteAddress);
        if (!approved)
          return send(response, 401, { error: 'Unable to authenticate. Try again later.' });
        let plan;
        try {
          plan = connectionPlan(body, request);
        } catch (error) {
          return send(response, 403, { error: error.message });
        }
        const admission = sessionStore.connectApproved(
          approved,
          request.socket.remoteAddress,
          request.headers['user-agent'] || '',
        );
        if (admission.ok) {
          try {
            await approvedClients.markConnected(approved.id);
          } catch (error) {
            sessionStore.disconnect(admission.sessionId);
            throw error;
          }
        }
        return sendAdmission(response, admission, plan);
      }
      if (route === '/api/connect') {
        if (policy?.busy)
          return send(response, 409, { error: 'Host settings are being applied. Retry shortly.' });
        if (typeof body.password !== 'string' || body.password.length > 64)
          return send(response, 400, { error: 'Password is required' });
        const key = sessionStore.keys.inspect(body.password);
        if (!key || !ordinaryKeyAllowed(key.purpose))
          return send(response, 401, { error: 'Unable to authenticate. Try again later.' });
        let plan;
        try {
          plan = connectionPlan(body, request);
        } catch (error) {
          return send(response, 403, { error: error.message });
        }
        return sendAdmission(
          response,
          sessionStore.connect(
            body.password.trim().toUpperCase(),
            request.socket.remoteAddress,
            request.headers['user-agent'] || '',
          ),
          plan,
        );
      }
      const token = request.headers.authorization?.match(/^Bearer ([a-f0-9-]{36})$/)?.[1];
      const session = sessionStore.get(token);
      if (!session || session.clientKey !== request.socket.remoteAddress)
        return send(response, 401, { error: 'Session expired. Reconnect.' });
      if (runtime) {
        if (['/api/offer', '/api/reconnect', '/api/telemetry'].includes(route))
          return send(response, 409, { error: 'Reload the viewer to use stream subscriptions.' });
        if (route === '/api/streams') return send(response, 200, { streams: runtime.list(token) });
        if (route === '/api/audio-telemetry') {
          if (runtime.audio.get(token)?.id !== body.streamId)
            return send(response, 404, { error: 'Unknown audio stream' });
          return runtime.recordAudio(token, body.streamId, body)
            ? send(response, 204)
            : send(response, 429, { error: 'Sample rate exceeded or audio inactive' });
        }
        if (route === '/api/stream-select')
          return send(response, 200, await runtime.selectStream(token, body.streamId));
        if (route === '/api/stream-offer' || route === '/api/audio-offer') {
          if (
            typeof body.sdp !== 'string' ||
            !body.sdp.startsWith('v=0') ||
            body.sdp.length > 65536
          )
            return send(response, 400, { error: 'Invalid SDP' });
          try {
            return send(
              response,
              200,
              await (route === '/api/audio-offer'
                ? runtime.offerAudio(token, body.sdp)
                : runtime.offerVideo(token, body)),
            );
          } catch (error) {
            return send(response, error.status || 503, {
              error: error.status
                ? error.message
                : 'Stream negotiation failed. Check server diagnostics.',
            });
          }
        }
        if (['/api/stream-stop', '/api/stream-telemetry'].includes(route)) {
          if (!runtime.registry.get(token, body.streamId))
            return send(response, 404, { error: 'Unknown stream' });
          if (route === '/api/stream-stop') {
            await runtime.stopStream(token, body.streamId);
            return send(response, 204);
          }
          return runtime.record(token, body.streamId, body)
            ? send(response, 204)
            : send(response, 429, { error: 'Sample rate exceeded or stream inactive' });
        }
        if (route === '/api/heartbeat')
          return send(response, 200, {
            controlAllowed: runtime.control.owner?.sessionId === token,
            controlStreamId:
              runtime.control.owner?.sessionId === token ? runtime.control.owner.streamId : null,
            streams: runtime.list(token),
            inventoryRevision: inventory?.revision,
          });
      } else if (route.startsWith('/api/stream'))
        return send(response, 404, { error: 'Not found' });
      if (reconnecting.has(token) && !['/api/heartbeat', '/api/disconnect'].includes(route))
        return send(response, 409, { error: 'This session is reconnecting. Retry shortly.' });
      if (route === '/api/profiles') {
        const catalog = policy?.snapshot() ?? defaultStreamPolicy();
        return send(response, 200, {
          serverName,
          profiles: await applyProfileOrder(
            profileOrderFile,
            catalog.profiles.filter((p) => p.enabled),
          ),
          clientMode: catalog.clientMode,
          allowedOptions: catalog.clientMode === 'options' ? catalog.allowedOptions : null,
          allowAudio: catalog.allowAudio,
          revision: catalog.revision,
          displays: inventory?.allowed(catalog),
          inventoryRevision: inventory?.revision,
          display:
            session.display ??
            (display
              ? {
                  id: 'primary',
                  name: 'Primary display',
                  width: display.width,
                  height: display.height,
                }
              : null),
        });
      }
      if (route === '/api/reconnect') {
        if (policy?.busy)
          return send(response, 409, { error: 'Host settings are being applied. Retry shortly.' });
        const snapshot = policy?.snapshot() ?? defaultStreamPolicy();
        let effective, selectedDisplay;
        try {
          if (inventory)
            selectedDisplay = inventory.select(
              snapshot,
              body.displayId ?? session.display?.id,
              body.inventoryRevision ?? session.inventoryRevision,
            );
          effective = resolveStreamPolicy(snapshot, {
            displayId: selectedDisplay?.id,
            profileId: body.profile ?? 'auto',
            custom: body.custom,
            audio: body.audio !== 'off',
            userAgent: request.headers['user-agent'] || '',
          });
        } catch (error) {
          return send(response, 403, { error: error.message });
        }
        // Validate first. Retire the old worker completely before issuing a new token.
        const inventoryRevision = inventory?.revision;
        reconnecting.add(token);
        try {
          const passwordGeneration = sessionStore.password;
          await media?.stop(token);
          if (
            sessionStore.password !== passwordGeneration ||
            (inventory && inventory.revision !== inventoryRevision) ||
            (policy && (policy.busy || policy.snapshot().revision !== snapshot.revision))
          ) {
            sessionStore.disconnect(token);
            return send(response, 409, { error: 'Host settings changed. Reconnect.' });
          }
          const result = sessionStore.replaceSession(token);
          if (!result.ok)
            return send(response, 409, {
              error: 'Session ended or another client connected. Reconnect.',
            });
          const audio = chooseAudioMode(effective.audio.mode);
          sessionStore.setProfile(result.sessionId, effective.profile);
          sessionStore.setDisplay(result.sessionId, selectedDisplay, inventory?.revision);
          sessionStore.setAudio(result.sessionId, audio);
          if (policy) sessionStore.setPolicyRevision(result.sessionId, effective.revision);
          return send(response, 201, {
            sessionId: result.sessionId,
            controlEnabled: false,
            profile: effective.profile,
            audio,
            display: selectedDisplay,
          });
        } finally {
          reconnecting.delete(token);
        }
      }
      if (route === '/api/telemetry') {
        const now = Date.now();
        if (now - (telemetryTimes.get(token) ?? -Infinity) < 800)
          return send(response, 429, { error: 'Sample rate exceeded' });
        telemetryTimes.set(token, now);
        const streamDiagnostics = media?.workers?.get(token)?.diagnostics ?? diagnostics;
        streamDiagnostics?.record('client', body);
        media?.receiverFeedback?.(token, body);
        return send(response, 204);
      }
      if (route === '/api/disconnect') {
        sessionStore.disconnect(token);
        await runtime?.stopSession(token);
        await media?.stop(token);
        return send(response, 204);
      }
      if (route === '/api/heartbeat') return send(response, 204);
      if (policy && (policy.busy || session.policyRevision !== policy.snapshot().revision)) {
        sessionStore.disconnect(token);
        return send(response, 409, { error: 'Host settings changed. Reconnect.' });
      }
      if (!media) return send(response, 503, { error: 'Native media is unavailable.' });
      if (typeof body.sdp !== 'string' || body.sdp.length > 65536 || !body.sdp.startsWith('v=0'))
        return send(response, 400, { error: 'Invalid SDP' });
      try {
        if (inventory)
          inventory.select(policy.snapshot(), session.display?.id, session.inventoryRevision);
        const answer = await media.offer(
          token,
          body.sdp,
          session.profile,
          session.audio,
          session.display,
        );
        if (!sessionStore.get(token)) return send(response, 401, { error: 'Session expired' });
        return send(response, 200, { type: 'answer', sdp: answer });
      } catch (error) {
        if (error.code === 'MEDIA_BUSY')
          return send(response, 409, { error: 'Stream already active or media capacity reached.' });
        sessionStore.disconnect(token);
        await media?.stop(token);
        return send(response, 503, {
          error: 'Media negotiation failed. Check the server diagnostics log.',
        });
      }
    } catch (error) {
      if (!response.headersSent && !response.destroyed)
        send(response, error.status || 500, {
          error: error.status ? error.message : 'Server error',
        });
    }
  };
  const server = createServer(requestListener);
  const revoke = sessionStore.onRevoke;
  sessionStore.onRevoke = (id) => {
    telemetryTimes.delete(id);
    revoke(id);
    media?.stop(id);
  };
  const sweep = setInterval(() => sessionStore.sweep(), 1000).unref();
  server.on('close', () => {
    clearInterval(sweep);
    sessionStore.stop();
  });
  applyServerLimits(server);
  server.sessionStore = sessionStore;
  // Exposed so a caller (main.mjs's TLS listener, or a test) can hand the identical
  // request-handling logic to `https.createServer`, so both the plaintext and TLS
  // listeners share one codepath for routing, sessions, and headers rather than two.
  server.requestListener = requestListener;
  return server;
}
