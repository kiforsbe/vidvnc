import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { SessionStore } from './session-store.mjs';
import { chooseProfile } from './profiles.mjs';
import { chooseAudioMode } from './audio.mjs';
import { defaultStreamPolicy, resolveStreamPolicy } from './stream-policy.mjs';
import { applyProfileOrder } from './profile-order.mjs';
import { isAllowedOrigin } from './tls/origin.mjs';
import {
  anchorReport,
  ENROLMENT_NOT_REQUIRED,
  ENROLMENT_REQUIRED,
  ENROLMENT_UNKNOWN,
} from './tls/anchor.mjs';
import { applyServerLimits } from './server-limits.mjs';
import { createPeerNetwork } from './peer-network.mjs';
import {
  announceCandidates,
  filterOfferCandidates,
  publicIpv4Addresses,
} from './sdp-candidates.mjs';
import { createLocalSessionScope } from './local-session-scope.mjs';
import { AdmissionBudget } from './admission-budget.mjs';
import { CONNECTION_KEY_PURPOSES } from './connection-keys.mjs';
import { parseRequestTarget } from './http-request-target.mjs';
import { ViewerAssetGrants, clearViewerCookie, viewerCookie } from './viewer-asset-grants.mjs';

const VIEWER_ASSETS = new Map([
  ['/viewer/fragment.html', 'viewer/fragment.html'],
  ['/viewer/app.js', 'viewer/app.js'],
  ['/viewer/style.css', 'viewer/style.css'],
  ['/viewer/receiver-stats.js', 'receiver-stats.js'],
  ['/viewer/stream-subscriptions.js', 'stream-subscriptions.js'],
  ['/viewer/codec-preferences.js', 'codec-preferences.js'],
  ['/viewer/profile-labels.js', 'profile-labels.js'],
  ['/viewer/stage-geometry.js', 'viewer/stage-geometry.js'],
]);

function send(response, status, body) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...(status === 429 ? { 'retry-after': '60' } : {}),
  });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}
// The three enrolment endpoints fixed by ruling before Task 11 exists to implement their
// handlers (see the plan's progress ledger, ruling R2). They stay reachable on the
// plaintext listener, unredirected, because a device that does not yet trust the host has
// no un-warned way to fetch the trust anchor over the very connection that anchor exists
// to authenticate. Every other plaintext request redirects to the HTTPS equivalent once
// TLS is active. `/api/trust/anchor` and `/api/trust/status` are handled below, and `/trust`,
// the human page, is served from the static table further down.
//
// The page is more than one request. Its script, its stylesheets and every module its script
// imports are separate requests, and one the list missed would be redirected, cross-origin,
// to a certificate the device does not trust yet, breaking the page exactly when it is
// needed. So the list holds exactly what `trust.html` loads: whole paths, no prefixes and no
// patterns, all public files with nothing secret in them. tests/tls/trust-page.test.mjs
// derives that set from the real page and fails if the list and the page ever differ, in
// either direction. Adding an asset to the page means adding it here and to the static table.
// Shared theme/shell/style assets are also loaded by the viewer. Keep only the
// trust-specific paths local on HTTPS; an off-scope approved viewer still needs them.
export const TRUST_ONLY_PATHS = Object.freeze([
  '/trust',
  '/trust.js',
  '/trust.css',
  '/trust-model.js',
  '/trust-instructions.js',
  '/api/trust/anchor',
  '/api/trust/status',
]);
export const PLAINTEXT_ALLOWED_PATHS = Object.freeze([
  ...TRUST_ONLY_PATHS,
  '/theme.js',
  '/style.css',
  '/shell.css',
]);

// What the two trust endpoints tell a device, decided once from the listener's `report()`
// (tls/listener.mjs, built on tls/anchor.mjs) so the download and the status can never
// disagree. Both are readable by any unauthenticated LAN client, on plaintext by design, so
// they say only public things: the state, the strategy's name, the anchor certificate and
// its fingerprint. Every `message` here is a fixed string chosen from the state and never
// derived from `report.failureReason`, which can embed file paths and provisioning detail
// (a `provided`-mode failure names the operator's certificate and key files). The reason
// stays in the log, the CLI and the host UI.
const TRUST_ANCHOR_PATH = '/api/trust/anchor';
const ANCHOR_FILENAME = 'VidVNC-trust.crt';
function trustOffer(report) {
  if (!report.active) {
    return {
      download: false,
      httpStatus: 503,
      message: report.failureReason
        ? 'HTTPS could not be started on this host, so there is no certificate to install. The reason is in the server log and host app.'
        : 'HTTPS is not running on this host, so there is no certificate to install.',
    };
  }
  if (report.enrolmentStatus === ENROLMENT_REQUIRED) {
    // Never an empty file with 200: an anchor with no bytes is reported as unavailable.
    if (!report.anchor?.raw?.length)
      return {
        download: false,
        httpStatus: 503,
        message: 'This host has no certificate to offer right now. Try again shortly.',
      };
    return {
      download: true,
      httpStatus: 200,
      message:
        'This host uses a certificate your device does not trust yet. Download and install it, then check that its fingerprint matches the one shown on the host.',
    };
  }
  if (report.enrolmentStatus === ENROLMENT_UNKNOWN)
    return {
      download: false,
      httpStatus: 404,
      message:
        'This host uses a certificate supplied by its operator and issued by another authority, so VidVNC has nothing to install. If your device does not already trust that issuer, ask your administrator for their CA certificate.',
    };
  return {
    download: false,
    httpStatus: 404,
    message:
      report.enrolmentStatus === ENROLMENT_NOT_REQUIRED
        ? 'This host uses a certificate your device already trusts, so there is nothing to install.'
        : 'This host has nothing to install.',
  };
}

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
// Routes an internet client never reaches, even with remote access on: `/api/key-start`
// takes a short code (the standing password, a one-time code or a setup code), so internet
// admission is approved-device sign-in only. Device setup therefore happens on the local
// network, like certificate enrolment (already local-only through TRUST_ONLY_PATHS).
export const INTERNET_REFUSED_PATHS = Object.freeze(['/api/key-start']);
const HSTS_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

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
  listenerScope = 'local',
  localSessionScope = createLocalSessionScope(),
  interfaces = networkInterfaces,
  admission = null,
  assetReader = readFile,
  log = console.error,
  // Injectable TLS status: `{ status() }` returning `{ active, port }`, read on every
  // request. Omitted, the app behaves as if TLS is inactive, which keeps every existing
  // caller (this app is constructed in dozens of tests with no `tls` option) byte-identical
  // to today: no redirect can ever fire unless a caller explicitly reports TLS as active.
  // main.mjs passes the TLS listener itself (tls/listener.mjs), whose `status()` is true
  // only while a listener is really bound. This function never provisions anything; it
  // only reads whatever status it is handed.
  tls = null,
  plaintextMode = tls ? 'https-required' : 'lan-http',
  // Tells internet clients from local and private-network ones (peer-network.mjs).
  peerNetwork = createPeerNetwork({ interfaces }),
  // Injectable for tests; production resolves the public names with DNS.
  resolvePublicIpv4 = null,
} = {}) {
  if (!['local', 'public'].includes(listenerScope)) throw new Error('Invalid listener scope');
  if (!['lan-http', 'https-required'].includes(plaintextMode))
    throw new Error('Invalid plaintext mode');
  admission ??= approvedClients?.admission ?? new AdmissionBudget();
  if (approvedClients && !approvedClients.admission) approvedClients.admission = admission;
  const reconnecting = new Set();
  const telemetryTimes = new Map();
  const viewerGrants = new ViewerAssetGrants();
  const connectionMode = () => access?.snapshot().connectionMode ?? 'session-key';
  const ordinaryKeyAllowed = (purpose) =>
    (purpose === 'session' && connectionMode() === 'session-key') ||
    (purpose === 'one-time-connection' && connectionMode() !== 'approved-only');
  const remoteAccess = () => access?.snapshot().remoteAccess === true;
  // A configured public name, as a parsed URL hostname (lowercase, IPv6 in brackets). They
  // count only while remote access is on.
  const isPublicHost = (host) =>
    remoteAccess() &&
    access
      .snapshot()
      .publicHostnames.some((name) => (isIP(name) === 6 ? `[${name}]` : name) === host);
  // An internet client's SDP answer names the router's public address instead of this PC's
  // private ones (sdp-candidates.mjs). Local and private-network clients get it unchanged.
  const answerFor = async (internet, sdp) =>
    internet && typeof sdp === 'string'
      ? announceCandidates(
          sdp,
          await (resolvePublicIpv4 ?? publicIpv4Addresses)(
            access?.snapshot().publicHostnames ?? [],
          ),
        )
      : sdp;
  // The HTTPS origin internet devices use: the first public name, on the public port or else
  // this PC's HTTPS port. Null until a public name is configured and a port is known.
  const remoteOrigin = () => {
    const settings = access?.snapshot();
    const name = settings?.publicHostnames?.[0];
    const port = settings?.publicPort ?? tls?.status?.()?.port ?? null;
    if (!name || !port) return null;
    return `https://${isIP(name) === 6 ? `[${name}]` : name}${port === 443 ? '' : `:${port}`}`;
  };
  // What the owner sees next to a pending registration's approve button.
  const registrationNetwork = (peer) =>
    localSessionScope.allows(peer, 'local')
      ? 'Local network'
      : peerNetwork.isInternet(peer)
        ? 'Internet'
        : 'Private network (not this LAN)';
  const allowedHost = (host) => {
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') return true;
    if (isPublicHost(host)) return true;
    for (const row of Object.values(interfaces()).flat()) {
      if (!row?.address) continue;
      const candidate = isIP(row.address) === 6 ? `[${row.address}]` : row.address;
      try {
        if (new URL(`http://${candidate}`).hostname === host) return true;
      } catch {
        // A scoped or malformed interface address is not a valid HTTP Host.
      }
    }
    return false;
  };
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
  function setViewerGrant(request, response, sessionId) {
    const value = viewerGrants.issue(sessionId, request.socket.remoteAddress);
    response.setHeader('set-cookie', viewerCookie(value, Boolean(request.socket.encrypted)));
  }
  function sendAdmission(request, response, result, plan) {
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
    setViewerGrant(request, response, result.sessionId);
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
    let keyAttempt = null;
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      // Internet clients first, so a refused one learns nothing else about the server. With
      // remote access off they get nothing at all; with it on, nothing that takes a short
      // code (they sign in as approved devices, set up on the local network). Private
      // networks that are not this LAN, such as a VPN, are not the internet: they keep the
      // ordinary rules below.
      const internet = peerNetwork.isInternet(request.socket.remoteAddress);
      if (internet && !remoteAccess())
        return send(response, 403, { error: 'Remote access is off.' });
      // The HTTP listener binds local addresses only, so this is a second line: whatever
      // reaches this handler from the internet, only an encrypted connection is served.
      if (internet && !request.socket.encrypted)
        return send(response, 403, { error: 'Use HTTPS.' });
      const host = new URL(`http://${request.headers.host}`).hostname;
      if (!allowedHost(host)) return send(response, 403, { error: 'Use the server IP address.' });
      // The scheme is read from the socket, not from a client-supplied header (e.g.
      // X-Forwarded-Proto): only the connection itself can say whether it is encrypted.
      const scheme = request.socket.encrypted ? 'https' : 'http';
      // A public name may arrive on the router's public port instead of this listener's.
      const publicPort = access?.snapshot().publicPort;
      const { route, pathAndQuery } = parseRequestTarget(
        request.url,
        scheme,
        request.headers.host,
        scheme === 'https' && publicPort && isPublicHost(host)
          ? [request.socket.localPort, publicPort]
          : request.socket.localPort,
      );
      const isLocal = localSessionScope.allows(request.socket.remoteAddress, 'local');
      if (scheme === 'http' && !isLocal)
        return send(response, 403, { error: 'Local network only.' });
      // This handler serves the public-capable HTTP and HTTPS ports. Diagnostics live
      // exclusively on a separate loopback-bound listener, even for local callers.
      if (
        route === '/diagnostics' ||
        route === '/api/diagnostics' ||
        route === '/diagnostics.js' ||
        route === '/diagnostics-auth.js' ||
        route === '/diagnostics.css'
      )
        return send(response, 404, { error: 'Not found' });
      if (TRUST_ONLY_PATHS.includes(route) && !isLocal)
        return send(response, 403, { error: 'Trust enrollment is local only.' });
      // Plaintext redirect: once TLS is active, every plaintext request except the
      // enrolment allow-list is sent to its HTTPS equivalent, preserving path and query
      // (`request.url` already carries both). 307 (not 301/302) so a non-GET request keeps
      // its method; it is deliberately not 308, which browsers cache permanently by
      // default — a cached redirect to the TLS port would keep sending a client there
      // after TLS is switched off or the port changes, so the response also says
      // `no-store`. The check runs AFTER the host allow-list above: the Location is built
      // from the already-allow-listed hostname and this listener's own TLS port, never
      // from the raw Host header, so it cannot be steered to another site. Only
      // Validated origin-form and absolute-form targets both have a safe path/query.
      if (scheme === 'http' && !PLAINTEXT_ALLOWED_PATHS.includes(route)) {
        const tlsStatus = tls?.status() ?? { active: false, port: null };
        if (tlsStatus.active) {
          response.writeHead(307, {
            location: `https://${host}:${tlsStatus.port}${pathAndQuery}`,
            'cache-control': 'no-store',
          });
          return response.end();
        }
        if (plaintextMode === 'https-required')
          return send(response, 503, { error: 'HTTPS is unavailable.' });
      }
      if (!isAllowedOrigin(scheme, request.headers.host, request.headers.origin))
        return send(response, 403, { error: 'Cross-origin request denied' });
      if (scheme === 'https' && isPublicHost(host))
        response.setHeader('strict-transport-security', `max-age=${HSTS_MAX_AGE_SECONDS}`);
      if (internet && INTERNET_REFUSED_PATHS.includes(route))
        return send(response, 403, {
          error:
            'Codes and device setup work on the local network only. From the internet, sign in with an approved device.',
        });
      const viewerFile = VIEWER_ASSETS.get(route);
      if (request.method === 'GET' && viewerFile) {
        const peer = request.socket.remoteAddress;
        const cookie = request.headers.cookie;
        if (!viewerGrants.allows(cookie, peer, sessionStore))
          return send(response, 404, { error: 'Not found' });
        let body;
        try {
          body = await assetReader(
            new URL(import.meta.resolve(`@vidvnc/web-client/${viewerFile}`)),
          );
        } catch (error) {
          if (error.code === 'ENOENT') return send(response, 404, { error: 'Not found' });
          throw error;
        }
        if (!viewerGrants.allows(cookie, peer, sessionStore))
          return send(response, 404, { error: 'Not found' });
        response.writeHead(200, {
          'content-type': viewerFile.endsWith('.js')
            ? 'text/javascript'
            : viewerFile.endsWith('.css')
              ? 'text/css'
              : 'text/html',
          'cache-control': 'no-store',
        });
        return response.end(body);
      }
      if (
        request.method === 'GET' &&
        [
          '/',
          '/app.js',
          '/approved-client.js',
          '/connection-link.js',
          '/password-entry.js',
          '/style.css',
          '/theme.js',
          '/shell.css',
          // Home Screen installation: public, and nothing secret in them.
          '/manifest.webmanifest',
          '/icon-180.png',
          '/icon-512.png',
          // The enrolment page and what it loads (see PLAINTEXT_ALLOWED_PATHS).
          '/trust',
          '/trust.js',
          '/trust.css',
          '/trust-model.js',
          '/trust-instructions.js',
        ].includes(route)
      ) {
        const file =
          route === '/' ? 'index.html' : route === '/trust' ? 'trust.html' : route.slice(1);
        const body = await readFile(new URL(import.meta.resolve(`@vidvnc/web-client/${file}`)));
        response.writeHead(200, {
          'content-type': file.endsWith('.js')
            ? 'text/javascript'
            : file.endsWith('.css')
              ? 'text/css'
              : file.endsWith('.png')
                ? 'image/png'
                : file.endsWith('.webmanifest')
                  ? 'application/manifest+json'
                  : 'text/html',
          'cache-control': 'no-store',
        });
        return response.end(body);
      }
      if (request.method === 'GET' && route === '/api/info') {
        // Local and private-network visitors also learn the remote address, once one is set,
        // so an approved browser can carry its device key there (browsers keep that key per
        // address). Internet visitors are already on it and get only the public name.
        const remote = internet ? null : remoteOrigin();
        return send(response, 200, {
          publicName: access?.snapshot().publicName ?? 'VidVNC host',
          ...(remote ? { remoteOrigin: remote } : {}),
        });
      }
      // Trust-anchor enrolment (see `trustOffer`). Behind the host and origin guards above
      // and, like every other route, reachable on either listener; the plaintext one leaves
      // these paths unredirected (PLAINTEXT_ALLOWED_PATHS). No `tls`, or a `tls` without
      // `report()`, is TLS inactive.
      // The enrolment page itself is a GET in the static table above; any other method on it
      // lands here, so it answers like the two endpoints do instead of as an unknown route.
      if (route === '/trust') return send(response, 405, { error: 'GET required' });
      if (route === TRUST_ANCHOR_PATH || route === '/api/trust/status') {
        if (request.method !== 'GET') return send(response, 405, { error: 'GET required' });
        const report = tls?.report?.() ?? { ...anchorReport(null), failureReason: null };
        const offer = trustOffer(report);
        if (route === TRUST_ANCHOR_PATH) {
          if (!offer.download)
            return send(response, offer.httpStatus, {
              error: offer.message,
              enrolmentStatus: report.enrolmentStatus,
            });
          // DER, not PEM: `application/x-x509-ca-cert` is the type iOS, Android and Windows
          // offer to install, and DER is what they parse. The bytes are the public anchor
          // certificate only (`anchor.raw`), never the credential's key. `no-store`
          // because a reissue changes the anchor.
          response.writeHead(200, {
            'content-type': 'application/x-x509-ca-cert',
            'content-disposition': `attachment; filename="${ANCHOR_FILENAME}"`,
            'content-length': report.anchor.raw.length,
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
          });
          return response.end(report.anchor.raw);
        }
        const live = tls?.status?.();
        return send(response, 200, {
          active: report.active,
          enrolmentStatus: report.enrolmentStatus,
          strategy: report.strategy,
          fingerprint: report.fingerprint,
          httpsPort: report.active && live?.active ? live.port : null,
          message: offer.message,
          ...(offer.download ? { download: TRUST_ANCHOR_PATH } : {}),
        });
      }
      if (
        request.method !== 'POST' ||
        ![
          '/api/key-start',
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
      const peer = request.socket.remoteAddress;
      keyAttempt =
        route === '/api/key-start'
          ? admission.beginKeyStart(peer, {
              ephemeral: sessionStore.keys.activeEphemeral(),
              session: sessionStore.keys.activeSession(),
            })
          : null;
      const rollingAttempt =
        route === '/api/approved-clients/sign-in'
          ? admission.beginSignIn(peer, undefined, { internet })
          : route === '/api/approved-clients/register'
            ? admission.beginRegistration(peer, { internet })
            : route === '/api/approved-clients/status'
              ? admission.beginStatus(peer, { internet })
              : null;
      if ((keyAttempt && !keyAttempt.ok) || (rollingAttempt && !rollingAttempt.ok))
        return send(response, 429, { error: 'Try again later or request a new host code.' });
      if (!request.headers['content-type']?.startsWith('application/json'))
        return (keyAttempt?.finish(null, false), send(response, 415, { error: 'JSON required' }));
      if (Number(request.headers['content-length']) > 128 * 1024) {
        request.resume();
        keyAttempt?.finish(null, false);
        return send(response, 413, { error: 'Request too large' });
      }
      let body;
      try {
        body = await readJson(request);
      } catch (error) {
        keyAttempt?.finish(null, false);
        throw error;
      }
      if (
        route === '/api/approved-clients/sign-in' &&
        !rollingAttempt.assignIdentity(body.clientId)
      )
        return send(response, 429, { error: 'Try again later.' });
      if (route === '/api/key-start') {
        if (policy?.busy) {
          keyAttempt.cancel();
          return send(response, 409, { error: 'Host settings are being applied. Retry shortly.' });
        }
        const record = sessionStore.keys.inspect(body.key);
        if (
          !record ||
          !keyAttempt.allowsPurpose(record.purpose) ||
          (record.purpose === CONNECTION_KEY_PURPOSES.session &&
            !localSessionScope.allows(peer, listenerScope))
        ) {
          keyAttempt.finish(null, false);
          return send(response, 401, { error: 'Unable to authenticate.' });
        }
        if (record.purpose === CONNECTION_KEY_PURPOSES.setup) {
          if (!approvedClients) {
            keyAttempt.cancel();
            return send(response, 503, { error: 'Approved-client setup is unavailable.' });
          }
          let ticket;
          try {
            ticket = approvedClients.issueRegistrationTicket();
          } catch (error) {
            keyAttempt.cancel();
            return send(response, 503, { error: 'Client registration is busy.' });
          }
          sessionStore.keys.use(body.key, record.purpose);
          keyAttempt.finish(record.purpose, true);
          return send(response, 202, ticket);
        }
        if (!ordinaryKeyAllowed(record.purpose)) {
          keyAttempt.finish(null, false);
          return send(response, 401, { error: 'Unable to authenticate.' });
        }
        let plan;
        try {
          plan = connectionPlan(body, request);
        } catch (error) {
          keyAttempt.finish(null, false);
          return send(response, 403, { error: error.message });
        }
        const result = sessionStore.connect(body.key, peer, request.headers['user-agent'] || '');
        keyAttempt.finish(record.purpose, result.ok || result.reason === 'busy');
        return sendAdmission(request, response, result, plan);
      }
      if (route === '/api/approved-clients/register') {
        if (!approvedClients)
          return send(response, 503, { error: 'Approved-client setup is unavailable.' });
        try {
          const result = await approvedClients.submit({
            ...body,
            // From the peer actually registering, never from which listener it used: both
            // listeners share this handler, so the listener says nothing about the peer.
            network: registrationNetwork(peer),
          });
          return send(response, 202, result);
        } catch (error) {
          return send(response, /ticket/i.test(error.message) ? 401 : error.status || 400, {
            error: /ticket/i.test(error.message)
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
        if (!approvedClients.stillAuthorized(approved))
          return send(response, 401, { error: 'Unable to authenticate.' });
        const admission = sessionStore.connectApproved(
          approved,
          request.socket.remoteAddress,
          request.headers['user-agent'] || '',
        );
        if (admission.reason === 'already-in-use')
          return send(response, 409, {
            code: 'approved-client-in-use',
            error: 'This approved browser credential is already in use.',
          });
        if (admission.ok) {
          try {
            await approvedClients.markConnected(approved.id, approved.generation);
            if (!approvedClients.stillAuthorized(approved))
              throw new Error('Stale approved-client authorization');
          } catch (error) {
            sessionStore.disconnect(admission.sessionId);
            await runtime?.stopSession(admission.sessionId);
            return send(response, /stale/i.test(error.message) ? 401 : 503, {
              error: 'Unable to authenticate.',
            });
          }
        }
        return sendAdmission(request, response, admission, plan);
      }
      const token = request.headers.authorization?.match(/^Bearer ([a-f0-9-]{36})$/)?.[1];
      const session = sessionStore.get(token);
      if (!session || session.clientKey !== request.socket.remoteAddress)
        return send(response, 401, { error: 'Session expired. Reconnect.' });
      const sendIfLive = (status, body) =>
        sessionStore.get(token)
          ? send(response, status, body)
          : send(response, 401, { error: 'Session expired. Reconnect.' });
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
          return sendIfLive(200, await runtime.selectStream(token, body.streamId));
        if (route === '/api/stream-offer' || route === '/api/audio-offer') {
          if (
            typeof body.sdp !== 'string' ||
            !body.sdp.startsWith('v=0') ||
            body.sdp.length > 65536
          )
            return send(response, 400, { error: 'Invalid SDP' });
          try {
            // With the media relay the runtime strips the offer's candidates and returns the
            // answer with the relay's addresses; without it (tests), filter and announce here.
            const relayed = Boolean(runtime.relay);
            const offer = internet && !relayed ? filterOfferCandidates(body.sdp) : body.sdp;
            const network = {
              internet,
              clientHint: request.socket.remoteAddress ?? null,
              localAddress: request.socket.localAddress,
            };
            const answer = await (route === '/api/audio-offer'
              ? runtime.offerAudio(token, offer, network)
              : runtime.offerVideo(token, { ...body, sdp: offer }, network));
            return sendIfLive(200, {
              ...answer,
              sdp: relayed ? answer.sdp : await answerFor(internet, answer.sdp),
            });
          } catch (error) {
            if (!sessionStore.get(token))
              return send(response, 401, { error: 'Session expired. Reconnect.' });
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
            return sendIfLive(204);
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
        const profiles = await applyProfileOrder(
          profileOrderFile,
          catalog.profiles.filter((p) => p.enabled),
        );
        return sendIfLive(200, {
          serverName,
          profiles,
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
          setViewerGrant(request, response, result.sessionId);
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
        response.setHeader('set-cookie', clearViewerCookie(Boolean(request.socket.encrypted)));
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
          internet ? filterOfferCandidates(body.sdp) : body.sdp,
          session.profile,
          session.audio,
          session.display,
        );
        if (!sessionStore.get(token)) return send(response, 401, { error: 'Session expired' });
        return send(response, 200, { type: 'answer', sdp: await answerFor(internet, answer) });
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
      keyAttempt?.finish(null, false);
      if (!response.headersSent && !response.destroyed)
        send(response, error.status || 500, {
          error: error.status ? error.message : 'Server error',
        });
    }
  };
  const server = createServer(requestListener);
  const revoke = sessionStore.onRevoke;
  sessionStore.onRevoke = (id) => {
    viewerGrants.revoke(id);
    telemetryTimes.delete(id);
    revoke(id);
    media?.stop(id);
  };
  const sweep = setInterval(() => sessionStore.sweep(), 1000).unref();
  const claimSweep =
    approvedClients &&
    setInterval(() => {
      approvedClients
        .sweepExpired()
        .catch((error) => log(`Approved-client expiry cleanup failed: ${error.message}`));
    }, 60_000).unref();
  server.on('close', () => {
    viewerGrants.clear();
    clearInterval(sweep);
    clearInterval(claimSweep);
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
