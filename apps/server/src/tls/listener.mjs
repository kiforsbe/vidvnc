// The second, TLS-terminating listener that runs alongside the plaintext one, and
// everything about keeping it alive: provisioning a credential, binding, reporting every
// way that can fail, and rotating the credential in place later.
//
// This lives in its own module, rather than inline in main.mjs, for one reason: main.mjs
// is a script that starts the whole server on import, so nothing inside it can be
// exercised by a test. Every failure-handling row in the design ("no strategy succeeds",
// "provided certificate fails", "TLS port already in use", "certificate expires while
// running") is behaviour of *this* code, and each is proven by a test that injects the
// certificate orchestration (`ensureCertificate`) so no test ever reaches real mkcert or
// Windows certificate tooling.
//
// The governing rule, from the design: TLS is an improvement, never a precondition. So
// nothing here may throw to the caller or leave an unhandled error event, and every
// failure that leaves the product plaintext is logged, with its reason, because silent
// degradation is the one outcome the design refuses.
import { createServer as nodeCreateServer } from 'node:https';
import { ensureCertificate as realEnsureCertificate } from './ensure-certificate.mjs';
import { applyServerLimits } from '../server-limits.mjs';

// `settings` is an already-validated TLS settings object (tls-settings.mjs).
// `requestListener` is the plaintext app's own request handler, so both listeners share
// one codepath for routing, sessions and headers.
// `ensureCertificate`, `createServer` and `log` are injectable; the defaults are the real
// ones and are what main.mjs uses.
//
// The returned object doubles as the `tls` option of `createHttpApp`: its `status()` is
// what the plaintext listener reads on every request to decide whether to redirect.
export function createTlsListener({
  settings,
  requestListener,
  host = '0.0.0.0',
  ensureCertificate = realEnsureCertificate,
  createServer = nodeCreateServer,
  log = (message) => console.error(message),
}) {
  let server = null; // set only while a listener is actually bound and serving
  let boundPort = null;
  let inflight = null;
  let closed = false;

  // Rotation: replace the running listener's secure context in place. Existing
  // connections keep the credential they negotiated with; new ones get the replacement.
  // The listener is never closed or rebuilt, so a renewal drops nothing.
  function rotate(result) {
    try {
      server.setSecureContext({ ...result.credential });
    } catch (error) {
      log(
        `TLS certificate rotation failed (${error.message}). Continuing with the current certificate.`,
      );
    }
  }

  function bind(result) {
    return new Promise((resolve) => {
      let secure;
      try {
        // Node validates the credential here, synchronously: a certificate/key pair that do
        // not belong together, or that cannot be parsed, throws from createServer. That
        // must degrade to plaintext like every other TLS failure — a throw inside this
        // executor would reject the attempt and, through a fire-and-forget caller, take the
        // process down.
        secure = createServer({ ...result.credential }, requestListener);
        applyServerLimits(secure);
      } catch (error) {
        log(
          `TLS configuration error (${error.message}). Serving plaintext only; the credential could not be used.`,
        );
        return resolve();
      }
      // Attached BEFORE listen(): a bind failure (most commonly EADDRINUSE) is reported
      // as an asynchronous 'error' event, not a thrown exception. With no listener that
      // event is unhandled and takes the whole process down, which is exactly what the
      // design's port-conflict row rules out. Plaintext keeps serving either way.
      secure.on('error', (error) => {
        const wasServing = server === secure;
        if (wasServing) {
          server = null;
          boundPort = null;
          secure.close();
        }
        log(
          error.code === 'EADDRINUSE'
            ? `TLS port ${settings.port} is already in use. Serving plaintext only.`
            : `TLS listener error on port ${settings.port} (${error.message}). Serving plaintext only.`,
        );
        resolve();
      });
      try {
        secure.listen(settings.port, host, () => {
          if (closed) {
            secure.close();
            return resolve();
          }
          server = secure;
          boundPort = secure.address().port;
          const warnings = result.warnings ?? [];
          log(
            `TLS ready on port ${boundPort} (strategy: ${result.strategy})` +
              (warnings.length ? ` — ${warnings.join('; ')}` : '') +
              '.',
          );
          resolve();
        });
      } catch (error) {
        // listen() throws synchronously for an out-of-range port or an invalid host.
        log(
          `TLS listener error on port ${settings.port} (${error.message}). Serving plaintext only.`,
        );
        resolve();
      }
    });
  }

  async function run() {
    let result;
    try {
      result = ensureCertificate(settings);
    } catch (error) {
      // ensureCertificate promises never to throw; a caller must still survive one that does.
      result = { ok: false, reason: error.message };
    }

    if (!result.ok) {
      const reason = result.reason ?? 'no TLS provisioning strategy is available';
      if (server) {
        log(`TLS re-check failed (${reason}). Continuing with the current certificate.`);
      } else if (settings.mode === 'provided') {
        // A configured certificate that cannot be used is the operator's configuration
        // error, and is never silently replaced by a generated one (ensureCertificate
        // guarantees that); say so plainly rather than wording it as a missing tool.
        log(
          `TLS configuration error: ${reason}. Serving plaintext only; no certificate was generated in its place.`,
        );
      } else {
        log(`TLS unavailable (${reason}). Serving plaintext only.`);
      }
      return;
    }

    if (server) rotate(result);
    else await bind(result);
  }

  return {
    // Ensures TLS is served by `settings`, or logs why not. Idempotent, and safe to call
    // repeatedly: at startup, then on every periodic re-check. Resolves when the attempt
    // has finished. It never rejects because of a `.catch` here that turns any failure
    // `run()` did not itself handle into a log line — not because `run()` cannot throw
    // (an earlier version of this module leaned on that assumption and a credential that
    // `createServer` rejected crashed the process through a fire-and-forget caller).
    // A call made while an earlier one is still binding joins it rather than racing it.
    attempt() {
      if (closed || settings.mode === 'off') return Promise.resolve();
      inflight ??= run()
        .catch((error) => {
          log(
            `TLS attempt failed unexpectedly (${error?.message ?? error}). Serving plaintext only.`,
          );
        })
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    // The live state the plaintext listener reads per request. `active` is true only
    // while a listener is really bound: a credential that was provisioned but failed to
    // bind must not send clients toward a port nothing is listening on.
    status() {
      return { active: server !== null, port: boundPort };
    },
    async close() {
      closed = true;
      const secure = server;
      server = null;
      boundPort = null;
      if (!secure) return;
      await new Promise((resolve) => {
        secure.close(resolve);
        secure.closeAllConnections();
      });
    },
  };
}
