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
// mode, only the strategy named `provided` is ever a candidate. `mkcert.mjs` and
// `windows-self-signed.mjs` both decide their own availability purely by probing the
// environment (does the binary resolve, is this Windows), not by consulting
// `settings.mode` at all — that boundary was set deliberately in Task 5
// (`mkcert.mjs:82-84`) and is not this module's to reopen — so without this restriction
// a failed `provided` certificate in `provided` mode could still fall through to a
// freshly generated one on a machine that happens to have mkcert installed — exactly the
// silent substitution the design forbids ("an operator who configured a certificate and
// silently got a self-signed one instead has been lied to").
//
// This filters by `name`, not by position (`strategies[0]`). An earlier version of this
// module used position, reasoning that the fixed order was itself a non-negotiable this
// module's own tests pin — but nothing actually *enforces* that "index 0" and "the
// `provided` strategy" stay the same thing: a future strategy inserted before `provided`
// in `DEFAULT_STRATEGIES`, or a caller passing `deps.strategies` (the same override the
// tests below use) with `provided` anywhere but first, would silently gate on the wrong
// strategy — reopening the exact "operator has been lied to" outcome this check exists
// to close, through the door position-based gating left open. Filtering by identity
// closes it regardless of where `provided` sits in the list. The loop body below stays
// byte-identical either way — this changes only how the candidate list is built, not how
// it is walked.
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
//
// `deps.force` (default false) is the one dep this module does not forward blindly. It
// asks the winning strategy to skip its own reuse check for exactly this call and reissue
// unconditionally — the host UI's "regenerate" action (Task 14). It is a dep, not a
// separate parameter, precisely so the reissue arithmetic stays where the header above
// says it lives: each strategy decides what "reissue" means for its own credential, and
// this module only passes the request along. Two things are stripped here:
//
//   * `provided` never receives it, in any mode. An operator-supplied certificate is
//     loaded, never generated, so there is nothing to regenerate, and the principle that
//     a configured certificate is never silently replaced applies to an explicit
//     regenerate request as much as to a failure.
//   * Nothing receives it in mode `off`, which returns before any strategy is consulted
//     at all (below) — there is no credential to reissue when TLS is not wanted.
//
// Defaulting to false everywhere means a caller that passes no `force` gets byte-identical
// behaviour to before this parameter existed; that is what keeps the reuse of an existing
// PFX (and with it its persisted passphrase, and every device already enrolled against it)
// the behaviour of every ordinary startup and periodic re-check.
export function ensureCertificate(settings, deps = {}) {
  const { strategies = DEFAULT_STRATEGIES, force = false } = deps;
  const depsFor = (strategy) =>
    strategy.name === 'provided' ? { ...deps, force: false } : { ...deps, force };

  // Mode `off`: no strategy is consulted at all, not even to ask whether it's
  // available. TLS is not wanted, so nothing about the environment or any configured
  // certificate is even inspected.
  if (settings?.mode === 'off') {
    return report({ ok: false, attempted: false });
  }

  // Mode `provided`: only the strategy named `provided` is ever a candidate, found by
  // identity rather than position — see the module-level comment above for why. In every
  // other mode every strategy is a candidate; `provided` naturally excludes itself
  // outside `provided` mode via its own `isAvailable(settings)`, so no restriction is
  // needed on that side.
  const candidates =
    settings?.mode === 'provided' ? strategies.filter((s) => s.name === 'provided') : strategies;

  const reasons = [];
  for (const strategy of candidates) {
    // `depsFor` differs from `deps` in exactly one key, `force` (see above); every other
    // dep is forwarded unchanged, and the walk itself still treats every candidate alike.
    const strategyDeps = depsFor(strategy);
    if (!strategy.isAvailable(settings, strategyDeps)) {
      reasons.push(skipped(strategy.name, `${strategy.name} is not available`));
      continue;
    }

    const result = strategy.provision(settings, strategyDeps);
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
