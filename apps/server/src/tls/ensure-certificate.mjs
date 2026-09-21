// Orchestrates the three certificate-provisioning strategies (Tasks 4-6: `provided`,
// `mkcert`, `windows-self-signed`) into the single call the rest of the TLS work builds
// on: "give me a credential to serve and the anchor to offer devices, or tell me why
// not." This module owns *strategy selection*, never *reissue arithmetic* — see the
// design note below, because that split is the one judgment call this module makes that
// isn't spelled out verbatim by its brief.
//
// ## Why reissue logic is NOT duplicated here
//
// `mkcert.mjs` and `windows-self-signed.mjs` each already implement the full reissue
// rule internally (`tryReuseExisting`, gated on `certificate-facts.mjs`'s documented
// `expired || needsRenewal || !covered` check) and are exercised for it in their own
// test suites. `provision()` is idempotent by contract for every strategy: calling it
// again either hands back the same still-usable credential untouched, or reissues,
// entirely inside the strategy's own call. A caller that re-checked the same three
// conditions before calling `provision()` would need the credential to check them
// against — which for `windows-self-signed` means reading its PFX and sidecar
// passphrase, knowledge that belongs to that strategy, not to this one — and would
// produce a second, inevitably slightly-different copy of a rule this codebase already
// wrote once and reviewed once. So this module's job is strategy selection and
// reporting: call `provision()` exactly once per strategy it tries, and pass back
// whatever that strategy decided, unmodified.
//
// ## Strategy selection
//
// Order is fixed: `provided`, then `mkcert`, then `windows-self-signed` (matching the
// array below and the design doc's own strategy table). Every strategy in play is
// walked with the exact same two calls, `isAvailable(settings, deps)` then
// `provision(settings, deps)` — no strategy gets special-cased inside that walk.
//
// The one piece of mode-driven gating that happens *before* the walk: in `provided`
// mode, only the first strategy is ever a candidate. This is not a name check inside the
// loop — `mkcert.mjs` and `windows-self-signed.mjs` both decide their own availability
// purely by probing the environment (does the binary resolve, is this Windows), not by
// consulting `settings.mode` at all, so without this restriction a failed `provided`
// certificate in `provided` mode could still fall through to a freshly generated one on
// a machine that happens to have mkcert installed — exactly the silent substitution the
// design forbids ("an operator who configured a certificate and silently got a
// self-signed one instead has been lied to"). Restricting the candidate list to
// `strategies[0]` uses only the ordering the strategy list is already required to have;
// it adds no new coupling to any strategy's name or identity.
import { providedStrategy } from './strategies/provided.mjs';
import { mkcertStrategy } from './strategies/mkcert.mjs';
import { windowsSelfSignedStrategy } from './strategies/windows-self-signed.mjs';

export const DEFAULT_STRATEGIES = [providedStrategy, mkcertStrategy, windowsSelfSignedStrategy];

// A single failed-or-skipped strategy's own reason, in the order it was tried. Every
// candidate this module actually calls `isAvailable`/`provision` on gets exactly one
// entry here unless it wins.
function skipped(strategyName, reason) {
  return { strategy: strategyName, reason };
}

// The report shape returned in every case (`off`, total failure, or success), so a
// caller never has to check which fields exist before reading them.
function report({
  ok,
  attempted,
  strategy = null,
  credential = null,
  anchor = null,
  warnings = [],
  reasons = [],
}) {
  return {
    ok,
    attempted,
    strategy,
    credential,
    anchor,
    warnings,
    reasons,
    // A single string for logging, matching the global constraint that a failure
    // leaving the product plaintext "must be visible, in the log and in the host UI" —
    // a caller that just wants one line to log does not need to format `reasons`
    // itself. `null` on success or when nothing was attempted (mode `off`), since
    // neither is a failure to report.
    reason:
      !ok && attempted
        ? reasons.map((entry) => `${entry.strategy}: ${entry.reason}`).join('; ') ||
          'no TLS provisioning strategy is available'
        : null,
  };
}

// Resolves a usable TLS credential for `settings`, trying each candidate strategy in
// order and returning the first success. Never throws: every strategy's own contract is
// "never throws, report `{ ok: false, reason }` instead", and this module adds nothing
// that could throw on top of that (no filesystem or subprocess access happens directly
// here — only through whatever the strategies do with the `deps` this module forwards
// to them unchanged).
//
// `deps` is forwarded verbatim to every `isAvailable`/`provision` call, exactly as each
// strategy already expects (`spawnSync`, `readFile`, `localAddresses`, `now`, etc. — see
// each strategy module for the full list). `deps.strategies` overrides the candidate
// list itself, which is how tests inject fakes instead of the real three strategies;
// real callers never need to pass it.
export function ensureCertificate(settings, deps = {}) {
  const { strategies = DEFAULT_STRATEGIES } = deps;

  // Mode `off`: no strategy is consulted at all, not even to ask whether it's
  // available. TLS is not wanted, so nothing about the environment or any configured
  // certificate is even inspected.
  if (settings?.mode === 'off') {
    return report({ ok: false, attempted: false });
  }

  // Mode `provided`: only the first (canonical-order) strategy is ever a candidate. See
  // the module-level comment above for why this is a candidate-list restriction, not a
  // name check inside the walk below.
  const candidates = settings?.mode === 'provided' ? strategies.slice(0, 1) : strategies;

  const reasons = [];
  for (const strategy of candidates) {
    if (!strategy.isAvailable(settings, deps)) {
      reasons.push(skipped(strategy.name, `${strategy.name} is not available`));
      continue;
    }

    const result = strategy.provision(settings, deps);
    if (result.ok) {
      return report({
        ok: true,
        attempted: true,
        strategy: strategy.name,
        credential: result.credential,
        anchor: result.anchor,
        warnings: result.warnings ?? [],
        reasons,
      });
    }

    reasons.push(skipped(strategy.name, result.reason));
  }

  return report({ ok: false, attempted: true, reasons });
}
