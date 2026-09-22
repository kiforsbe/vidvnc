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
import { anchorReport } from './anchor.mjs';

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
  // What `report()` describes. `served` is the anchor-bearing part of the latest
  // `ensureCertificate` result for the credential that is ACTUALLY serving. It is set only
  // after a bind that is really listening, or a rotation whose `setSecureContext` did not
  // throw, and never for a credential that failed either, so a report can never describe a
  // certificate no client is being handed. It is narrowed to what `anchorReport` reads
  // (`ok`, `strategy`, `anchor`), so the private key in `result.credential` is not kept
  // alive here for a report that has no use for it. `failureReason` is the latest failure,
  // cleared by the next success. It can outlive a served credential (a failed re-check),
  // and is then reported next to it.
  let served = null;
  let failureReason = null;

  const succeeded = (result) => {
    served = { ok: true, strategy: result.strategy, anchor: result.anchor ?? null };
    failureReason = null;
  };

  // Rotation: replace the running listener's secure context in place. Existing
  // connections keep the credential they negotiated with; new ones get the replacement.
  // The listener is never closed or rebuilt, so a renewal drops nothing.
  function rotate(result) {
    try {
      server.setSecureContext({ ...result.credential });
      succeeded(result);
    } catch (error) {
      failureReason = `certificate rotation failed (${error.message})`;
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
        failureReason = `the credential could not be used (${error.message})`;
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
          served = null; // nothing is serving any more, so nothing is described
          secure.close();
        }
        failureReason =
          error.code === 'EADDRINUSE'
            ? `port ${settings.port} is already in use`
            : `listener error on port ${settings.port} (${error.message})`;
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
          succeeded(result);
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
        failureReason = `listener error on port ${settings.port} (${error.message})`;
        log(
          `TLS listener error on port ${settings.port} (${error.message}). Serving plaintext only.`,
        );
        resolve();
      }
    });
  }

  async function run(force = false) {
    let result;
    try {
      result = ensureCertificate(settings, { force });
    } catch (error) {
      // ensureCertificate promises never to throw; a caller must still survive one that does.
      result = { ok: false, reason: error.message };
    }

    if (!result.ok) {
      const reason = result.reason ?? 'no TLS provisioning strategy is available';
      failureReason = reason;
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
    //
    // `force: true` (the host UI's regenerate action, Task 14) asks the winning strategy to
    // reissue rather than reuse what it already has. Two refusals are built in here, so the
    // caller cannot get a reissue this module has no business performing:
    //
    //   * mode `off` returns before anything is attempted, as it always has — there is no
    //     credential to regenerate.
    //   * mode `provided` downgrades the call to an ordinary attempt. An operator-supplied
    //     certificate is loaded, never generated, so "regenerate" would either mean nothing
    //     or mean replacing their certificate with a generated one, which is precisely the
    //     substitution the design forbids.
    //
    // A forced call also does NOT join an attempt already in flight, the way an ordinary one
    // does: that attempt was started without `force` and would return having reused the
    // existing credential, reporting success for a reissue that never happened. It queues
    // behind it instead. Ordinary calls keep their existing behaviour exactly — including
    // starting `run()` synchronously — so nothing about startup or the periodic re-check
    // changes.
    attempt({ force = false } = {}) {
      if (closed || settings.mode === 'off') return Promise.resolve();
      const forced = force && settings.mode !== 'provided';
      if (!forced && inflight) return inflight;
      const started = (forced && inflight ? inflight.then(() => run(true)) : run(forced))
        .catch((error) => {
          log(
            `TLS attempt failed unexpectedly (${error?.message ?? error}). Serving plaintext only.`,
          );
        })
        // Identity-guarded: a forced attempt queued behind this one has already replaced
        // `inflight`, and must not be cleared by its predecessor settling.
        .finally(() => {
          if (inflight === started) inflight = null;
        });
      inflight = started;
      return started;
    },
    // The live state the plaintext listener reads per request. `active` is true only
    // while a listener is really bound: a credential that was provisioned but failed to
    // bind must not send clients toward a port nothing is listening on.
    status() {
      return { active: server !== null, port: boundPort };
    },
    // What a device must trust to reach this listener, for the enrolment endpoints (Task
    // 11), the CLI (Task 13) and the host UI (Task 14): `anchor.mjs`'s report for the
    // credential that is serving, plus the latest failure reason. Inactive (`active: false`,
    // null anchor) whenever nothing is bound. `failureReason` is for the log, the CLI and
    // the host UI: it can embed file paths and provisioning detail, so a network-facing
    // reader (the HTTP endpoints) must not serve it.
    report() {
      return { ...anchorReport(served), failureReason };
    },
    async close() {
      closed = true;
      served = null;
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
