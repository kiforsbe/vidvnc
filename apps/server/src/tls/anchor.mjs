// Turns an `ensure-certificate.mjs` result into the one report both consumers of "what a
// device must trust" read: Task 11's enrolment endpoint (which serves the anchor as a
// downloadable file and answers whether enrolment is needed at all) and Task 14's host
// UI (which displays the fingerprint). Both are expected to read *this* function's
// output, never `ensureCertificate()`'s raw shape or `certificate-facts.mjs` directly —
// that convention is what keeps the page and the host UI from showing two different
// fingerprints for the same running credential. Nothing in the language enforces it (a
// future caller could still compute `fingerprint(result.anchor)` directly off the raw
// result); the guarantee holds by convention and by this module being the one documented
// place to get either value from, not because it is structurally impossible to bypass.
import { fingerprint as certificateFingerprint } from './certificate-facts.mjs';

// `enrolmentStatus` values. Exported so callers compare against a named constant rather
// than a bare string, and so a three-valued field can never be quietly read as a
// boolean: `if (!enrolmentStatus)` is not how any of these three are meant to be tested,
// and none of them is the empty/falsy value that pattern would need to work by accident.
export const ENROLMENT_REQUIRED = 'required';
export const ENROLMENT_UNKNOWN = 'unknown';
export const ENROLMENT_NOT_REQUIRED = 'not-required';

// The report `anchorReport` always returns, so a caller never has to branch on which
// fields exist before reading them:
//
//   active           — false only when there is no anchor at all: TLS is off, or every
//                       provisioning strategy failed. There is genuinely nothing running
//                       over HTTPS for a device to enrol into, which is a different
//                       statement from "nothing to install" below.
//   enrolmentStatus  — meaningful only when `active` is true. One of:
//                         ENROLMENT_REQUIRED     — here is what to trust; show the
//                                                   download and the fingerprint.
//                         ENROLMENT_NOT_REQUIRED — there is nothing to enrol; the
//                                                   endpoint should say so rather than
//                                                   offering a chain nobody should
//                                                   install.
//                         ENROLMENT_UNKNOWN      — the operator supplied this
//                                                   certificate (`provided` mode) and it
//                                                   is not self-issued, so it is chained
//                                                   to *something*, but this module has
//                                                   no dependency-free way to tell
//                                                   whether a given device's trust store
//                                                   already has that issuer. Task 11/14
//                                                   should render this distinctly from
//                                                   both of the above — e.g. "you
//                                                   supplied this certificate; if your
//                                                   devices already trust its issuer
//                                                   there is nothing to do, otherwise
//                                                   install your CA" — and still show the
//                                                   fingerprint either way.
//   strategy         — the winning strategy's name, or null when `active` is false.
//   anchor           — the X509Certificate a device must trust, or null. Handed back
//                       unmodified so a caller can get whatever representation it needs
//                       from it directly (`anchor.toString()` for PEM, `anchor.raw` for
//                       DER) without this module re-deriving either.
//   fingerprint      — `certificate-facts.mjs`'s `fingerprint(anchor)`, computed here
//                       once so every reader of this report sees the identical string;
//                       never recomputed independently by a caller. Null when there is no
//                       anchor.
//
// How `enrolmentStatus` is decided, in order:
//
//   1. The anchor is self-issued (`anchor.issuer === anchor.subject`) → REQUIRED. True of
//      every strategy-generated anchor: a self-signed `windows-self-signed` leaf, or an
//      mkcert local CA root, which is self-signed by definition, being a root. This
//      direction is never wrong — a self-issued anchor always needs installing on a
//      device that hasn't already been given it.
//   2. Otherwise, if the winning strategy is `provided` → UNKNOWN. The certificate is
//      chained to something (a real public CA, or an internal one the operator already
//      deployed), but validating it against any given device's actual trust store would
//      require chain/trust-store validation this project has no dependency-free way to
//      perform, and the design doc does not ask for. A boolean collapse here is exactly
//      the bug this three-valued status exists to avoid: defaulting UNKNOWN to "not
//      required" produces false reassurance for an operator whose internal CA a device
//      does not yet trust (a real browser warning while the endpoint says nothing is
//      needed); defaulting it to "required" instead would tell an operator with a
//      perfectly good public-CA certificate to enrol something nobody should install —
//      which is precisely what the design doc's `provided`-mode row asks this endpoint
//      NOT to do ("Whatever their CA chain already is; usually nothing to install"). So
//      neither default is safe to collapse to, and the status is reported as its own
//      distinct value instead.
//   3. Otherwise → REQUIRED (the safe default; not reachable by any of the three
//      strategies as they exist today, since `mkcert` and `windows-self-signed` anchors
//      are always self-issued and only `provided` can produce a non-self-issued one, but
//      a future strategy or a `provided` edge case should still fail toward "show the
//      user what to trust" rather than toward silence).
export function anchorReport(result) {
  const anchor = result?.ok ? (result.anchor ?? null) : null;

  if (!anchor) {
    // `enrolmentStatus` is `null`, not `ENROLMENT_NOT_REQUIRED`, when `active` is false:
    // the question "is there anything to install" does not apply when nothing is running
    // over HTTPS at all, so answering it with a real status value (even the "nothing to
    // do" one) would overstate what is known. `null` matches the "meaningless unless
    // active" framing documented above and keeps this consistent with `strategy`/
    // `anchor`/`fingerprint`, which are all `null` here too.
    return {
      active: false,
      enrolmentStatus: null,
      strategy: null,
      anchor: null,
      fingerprint: null,
    };
  }

  const selfIssued = anchor.issuer === anchor.subject;
  let enrolmentStatus = ENROLMENT_REQUIRED; // the safe default; see step 3 above.
  if (!selfIssued && result.strategy === 'provided') enrolmentStatus = ENROLMENT_UNKNOWN;

  return {
    active: true,
    enrolmentStatus,
    strategy: result.strategy,
    anchor,
    fingerprint: certificateFingerprint(anchor),
  };
}
