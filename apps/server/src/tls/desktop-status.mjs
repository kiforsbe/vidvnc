// The `tls` field the desktop host receives on every periodic `status` message
// (main.mjs's `statusTimer`), built here rather than inline at that call site so the one
// thing the host UI reads is a pure function with its own tests — main.mjs is a script
// that starts the whole server on import, so nothing written inside it can be exercised.
//
// It deliberately reuses Task 11's vocabulary (`active`, `enrolmentStatus`, `strategy`,
// `fingerprint`, from tls/anchor.mjs by way of the listener's `report()`) so the HTTP
// enrolment endpoint, the CLI's `tls` command and the host UI all name the same states the
// same way, and so a user comparing the fingerprint on the host screen against the one the
// enrolment page shows is comparing two renderings of one value, never two computations of
// it.
//
// ## What this must never contain
//
// `report().failureReason` is the listener's raw, unsanitized failure text. It is written
// for the server log and the local CLI and can embed provisioning detail and filesystem
// paths — in `provided` mode it names the operator's certificate and key files. It is
// never forwarded here. `reason` below is instead chosen from a fixed set of strings by
// looking only at *state* (is a listener bound, was there any failure at all, which mode is
// configured), so whatever the failure text says, what leaves this module is one of a
// handful of sentences written in advance. Nothing derived from a credential — a private
// key, a PFX byte, a passphrase — is reachable from the inputs this function reads
// (`report()` narrows its result to `ok`/`strategy`/`anchor` before this ever sees it).
//
// The cost of that rule is that `reason` cannot distinguish "the port was taken" from "no
// strategy worked"; it names the port and sends the reader to the log, which is where the
// full, unsanitized reason already goes. That is the trade the sanitization rule asks for,
// and the design's requirement is that the failure be *visible* in the host UI, not that it
// be diagnosable there.
import { renewalStatus } from './certificate-facts.mjs';

// Every sentence `reason` can ever be. Written out here, rather than assembled from the
// failure text, so this list is the exhaustive answer to "what can this field say".
const REASONS = {
  // A re-check failed while a credential is still serving. TLS is not degraded, but the
  // next renewal may not happen, so the host says so rather than showing nothing.
  staleCheck:
    'The latest certificate check failed. HTTPS is still running on the certificate it already had; the server log says why.',
  // `provided` mode: never silently replaced by a generated certificate (ensure-certificate.mjs
  // guarantees that), so the message says so explicitly instead of reading like a missing tool.
  provided: (port) =>
    `The certificate configured for this host could not be used, so HTTPS is not running on port ${port}. Nothing was generated in its place — check the TLS certificate settings and the server log.`,
  failed: (port) =>
    `HTTPS could not be started on port ${port}. The viewer is unavailable; HTTP viewer access is disabled. The server log says why.`,
  // The status message is sent once a second from the moment the plaintext listener binds,
  // which is deliberately before TLS has been provisioned (main.mjs), so this is the honest
  // state for the first moments of every run, not an error.
  pending: 'HTTPS has not started yet. The viewer is waiting; HTTP viewer access is disabled.',
  // The configured mode is 'off' only because the on-disk settings could not be used
  // (load-settings.mjs's `off()`), never because anyone asked for TLS to be off.
  // Distinguishing this from a deliberate `off` (which returns null below) is the point:
  // an operator whose config is broken must not be told HTTPS is deliberately disabled.
  invalidSettings:
    'The TLS settings could not be used, so HTTPS is off and HTTP viewer access is disabled. Nothing was changed; the server log says why.',
};

// `settings` is the validated TLS settings this process loaded at startup (tls-settings.mjs).
// `status` and `report` are `createTlsListener()`'s two readers, exactly as they come back.
// `now` is forwarded to `renewalStatus` so a test can evaluate expiry at a fixed instant.
//
// Every field is always present, so the host never has to check which ones exist:
//
//   mode            — the configured mode (`auto`/`provided`/`off`). Not part of the
//                      listener's own reports, but the host section shows it and decides
//                      from it whether regenerating is even meaningful.
//   active, port    — from `status()`: true only while a listener is really bound.
//   strategy        — the winning strategy's name, or null.
//   enrolmentStatus — anchor.mjs's three-valued status, or null when inactive.
//   fingerprint     — the served anchor's SHA-256 fingerprint, or null.
//   expiry          — the served anchor's `validTo` as an ISO 8601 string, or null.
//   expired,
//   needsRenewal    — certificate-facts.mjs's `renewalStatus`. A reader deciding whether
//                      the certificate needs attention must test `expired || needsRenewal`,
//                      never `needsRenewal` alone: the two are mutually exclusive by design,
//                      so testing only the second silently ignores an already-dead
//                      certificate. That rule applies to the host UI as much as to a reissue
//                      predicate here.
//   reason          — one of REASONS above, or null when there is nothing to say.
export function tlsDesktopStatus({
  settings,
  status,
  report,
  now,
  localHttpUrls = [],
  secureUrls = [],
} = {}) {
  const mode = settings?.mode ?? 'off';
  const configuredPort = settings?.port ?? null;
  const listening = status?.active === true;
  const anchor = report?.anchor ?? null;
  const renewal = anchor ? renewalStatus(anchor, now ? { now } : undefined) : null;
  const httpViewerEnabled = mode === 'off' && !settings?.invalid;
  const viewerUrls =
    listening && !settings?.invalid ? secureUrls : httpViewerEnabled ? localHttpUrls : [];

  return {
    mode,
    active: listening,
    port: status?.port ?? null,
    strategy: report?.strategy ?? null,
    enrolmentStatus: report?.enrolmentStatus ?? null,
    fingerprint: report?.fingerprint ?? null,
    expiry: renewal ? renewal.validTo.toISOString() : null,
    expired: renewal ? renewal.expired : false,
    needsRenewal: renewal ? renewal.needsRenewal : false,
    httpViewerEnabled,
    viewerReady: viewerUrls.length > 0,
    localHttpUrls,
    viewerUrls,
    reason: sanitizedReason({
      mode,
      listening,
      configuredPort,
      failed: Boolean(report?.failureReason),
      invalidSettings: Boolean(settings?.invalid),
    }),
  };
}

function sanitizedReason({ mode, listening, configuredPort, failed, invalidSettings }) {
  // Off is a configuration, not a failure — unless it is only off because the settings
  // could not be read or validated, which is a failure the operator has to be told about.
  if (mode === 'off') return invalidSettings ? REASONS.invalidSettings : null;
  if (listening) return failed ? REASONS.staleCheck : null;
  if (!failed) return REASONS.pending;
  return mode === 'provided' ? REASONS.provided(configuredPort) : REASONS.failed(configuredPort);
}
