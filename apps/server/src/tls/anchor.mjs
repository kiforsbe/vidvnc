// Turns an `ensure-certificate.mjs` result into the one report both consumers of "what a
// device must trust" read: Task 11's enrolment endpoint (which serves the anchor as a
// downloadable file and answers whether enrolment is needed at all) and Task 14's host
// UI (which displays the fingerprint). Both must read *this* function's output, never
// `ensureCertificate()`'s raw shape or `certificate-facts.mjs` directly — that is what
// makes it structurally impossible for the page and the host UI to show two different
// fingerprints for the same running credential: there is exactly one place that decides
// what either of them is allowed to say.
import { fingerprint as certificateFingerprint } from './certificate-facts.mjs';

// The report `anchorReport` always returns, so a caller never has to branch on which
// fields exist before reading them:
//
//   active          — false only when there is no anchor at all: TLS is off, or every
//                      provisioning strategy failed. There is genuinely nothing running
//                      over HTTPS for a device to enrol into, which is a different
//                      statement from "nothing to install" below.
//   needsEnrolment  — meaningful only when `active` is true. False means "there is
//                      nothing to enrol": the anchor is trusted already, so the
//                      enrolment endpoint should say so rather than offering a chain
//                      nobody should install. True means "here is what to trust": show
//                      the download and the fingerprint, the flow this design mostly
//                      describes.
//   strategy        — the winning strategy's name, or null when `active` is false.
//   anchor          — the X509Certificate a device must trust, or null. Handed back
//                      unmodified so a caller can get whatever representation it needs
//                      from it directly (`anchor.toString()` for PEM, `anchor.raw` for
//                      DER) without this module re-deriving either.
//   fingerprint     — `certificate-facts.mjs`'s `fingerprint(anchor)`, computed here
//                      once so every reader of this report sees the identical string;
//                      never recomputed independently by a caller. Null when there is no
//                      anchor.
//
// `needsEnrolment` decides "is there anything to install" the only way this module can
// without a dependency-free way to validate a certificate against a device's actual
// trust store (out of scope per the design doc, which does not name ACME/trust-store
// validation as something this project does): a *structural* self-issued check,
// `anchor.issuer === anchor.subject`. This is true of every strategy-generated anchor —
// a self-signed `windows-self-signed` leaf, or an mkcert local CA root, which is
// self-signed by definition, being a root — so both always report "here is what to
// trust". It is only *sometimes* true of an operator's own `provided` certificate:
// self-issued (the operator rolled their own without a real CA) still needs enrolling;
// issued by something else (a public CA, or an internal one the operator already
// deployed to their devices) does not, matching the design doc's own hedge for this
// case ("Whatever their CA chain already is; usually nothing to install"). This can be
// wrong in one direction only — an operator's certificate chained to an internal CA that
// is *not* yet trusted on a given device will be reported as needing no enrolment when a
// device would in fact still warn — but that is the same "usually" the design doc itself
// accepts for `provided` mode, and an operator running their own internal PKI already
// knows to check the chain themselves; it is never wrong in the other direction (a
// self-issued anchor is never reported as needing no enrolment).
export function anchorReport(result) {
  const anchor = result?.ok ? (result.anchor ?? null) : null;

  if (!anchor) {
    return {
      active: false,
      needsEnrolment: false,
      strategy: null,
      anchor: null,
      fingerprint: null,
    };
  }

  return {
    active: true,
    needsEnrolment: anchor.issuer === anchor.subject,
    strategy: result.strategy,
    anchor,
    fingerprint: certificateFingerprint(anchor),
  };
}
