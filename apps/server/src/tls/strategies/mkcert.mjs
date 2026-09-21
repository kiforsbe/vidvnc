// The "mkcert" certificate-provisioning strategy: when the operator already has mkcert
// (https://github.com/FiloSottile/mkcert) installed with a local certificate authority,
// issue a leaf certificate from that CA rather than generating a self-signed one. This is
// the good case named in the design doc: devices that already trust the operator's mkcert
// root see no browser warning at all, and reissuing the leaf later (address changes,
// renewal) never requires re-enrolling a device, because the anchor a device trusts is the
// CA root, not the leaf.
//
// Implements the same strategy shape Task 4 (`provided.mjs`) defines: `name`,
// `isAvailable(settings, deps)`, `provision(settings, deps)`, plus a bundled
// `{ name, isAvailable, provision }` object. `provision` is synchronous, never throws, and
// returns either `{ ok: true, credential, anchor, warnings: [] }` or `{ ok: false, reason }`.
//
// `anchor` here is deliberately a *different* certificate than the one used to build
// `credential`: the credential is built from the freshly issued (or reused) leaf, while the
// anchor is mkcert's own CA root certificate — "what a device must trust" per the shared
// shape's contract, not "the certificate this strategy issued." No special-casing is needed
// for that; the field was designed to carry exactly this.
//
// Every interaction with the mkcert binary goes through the injected `spawnSync`, which
// defaults to `node:child_process`'s synchronous variant — `provision` must stay synchronous
// to match every sibling module in this family (`local-addresses.mjs`, `certificate-facts.mjs`,
// `tls-settings.mjs`, `provided.mjs`), and a portable test suite must never require the real
// mkcert binary to exist.
//
// This strategy never installs anything: `mkcert -install` is never invoked, by design (see
// the design doc — "it does not install anything"). It only issues into VidVNC's own state
// directory and only reads mkcert's already-existing CA root; an mkcert CA that does not
// already exist on the machine simply makes this strategy unavailable, never a reason to
// create one.
import { readFileSync, mkdirSync } from 'node:fs';
import { spawnSync as childProcessSpawnSync } from 'node:child_process';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { loadCertificate, checkCoverage, renewalStatus } from '../certificate-facts.mjs';
import { localAddresses as discoverLocalAddresses } from '../local-addresses.mjs';
import { dataDirectory } from '../../paths.mjs';

export const name = 'mkcert';

// Where this strategy issues its own leaf, separate from anything else on the machine —
// never overwritten or reused from elsewhere. Injectable as `certificateDirectory` in
// `deps` so tests can confine every file this module touches to a temp directory.
function defaultCertificateDirectory() {
  return join(dataDirectory(), 'tls', 'mkcert');
}

// Runs `mkcert -CAROOT`, which prints mkcert's own CA root directory — the value is asked
// for, never guessed per-platform, since mkcert's own install layout is exactly the kind of
// detail this module must not hardcode. Returns `{ ok: true, rootDir }` or
// `{ ok: false, reason }`; never throws, even if `spawnSync` itself throws (a fake runner in
// tests might, and a real `spawnSync` can reject invalid options synchronously).
function runCaRoot(spawnSync) {
  let result;
  try {
    result = spawnSync('mkcert', ['-CAROOT'], { encoding: 'utf8' });
  } catch (error) {
    return { ok: false, reason: `mkcert is not available: ${error.message}` };
  }
  if (!result || result.error) {
    return {
      ok: false,
      reason: `mkcert is not available: ${result?.error?.message ?? 'mkcert did not run'}`,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `mkcert -CAROOT exited with status ${result.status}: ${(result.stderr ?? '').trim()}`,
    };
  }
  const rootDir = (result.stdout ?? '').trim();
  if (!rootDir) {
    return { ok: false, reason: 'mkcert -CAROOT printed no path' };
  }
  return { ok: true, rootDir };
}

// True only when the mkcert binary actually resolves and reports a CA root directory.
// Never throws — this is the sole condition for this strategy (see the design doc's
// strategy table: mkcert's condition is "mkcert resolves on PATH", with no dependency on
// TLS settings/mode; mode-based gating between strategies is Task 7's job, not this
// module's). `settings` is accepted only so every strategy shares the same call signature;
// this strategy does not consult it.
export function isAvailable(settings, { spawnSync = childProcessSpawnSync } = {}) {
  return runCaRoot(spawnSync).ok;
}

// Locates mkcert's CA root and parses it into the `X509Certificate` this strategy reports
// as `anchor`. Reads the root certificate through the injected `readFile`, never assuming
// the file mkcert claimed to have is actually there — a directory mkcert reports but whose
// `rootCA.pem` cannot be read is reported as a failure, never as a credential with a missing
// anchor.
function locateCaRootAnchor({ spawnSync, readFile }) {
  const rootResult = runCaRoot(spawnSync);
  if (!rootResult.ok) return rootResult;

  const rootCertPath = join(rootResult.rootDir, 'rootCA.pem');
  let rootBytes;
  try {
    rootBytes = readFile(rootCertPath);
  } catch (error) {
    return {
      ok: false,
      reason: `mkcert reported CA root directory "${rootResult.rootDir}" but "${rootCertPath}" could not be read: ${error.message}`,
    };
  }

  try {
    return { ok: true, anchor: new X509Certificate(rootBytes) };
  } catch (error) {
    return {
      ok: false,
      reason: `could not parse mkcert CA root certificate "${rootCertPath}": ${error.message}`,
    };
  }
}

// Checks whether the leaf certificate already issued into `certPath`/`keyPath` (from a
// prior run of this strategy) is still usable, per `certificate-facts.mjs`'s documented
// reissue rule: reuse only when the certificate is neither expired nor inside its renewal
// window, and only when it still covers every currently discovered address. Returns the
// credential to reuse, or `null` when there is nothing usable yet (no file, unreadable,
// unparseable, expired, needs renewal, or missing coverage) — every one of those is simply
// "reissue", not an error.
function tryReuseExisting(certPath, keyPath, { readFile, addresses, now }) {
  const certResult = loadCertificate(certPath, { readFile });
  if (!certResult.ok) return null;

  // IMPORTANT: check `expired || needsRenewal`, never `needsRenewal` alone — see
  // certificate-facts.mjs's doc comment on `renewalStatus`.
  const status = renewalStatus(certResult.certificate, now ? { now } : undefined);
  if (status.expired || status.needsRenewal) return null;

  const coverage = checkCoverage(certResult.certificate, addresses);
  if (!coverage.covered) return null;

  let certBytes;
  let keyBytes;
  try {
    certBytes = readFile(certPath);
    keyBytes = readFile(keyPath);
  } catch {
    return null;
  }

  return { credential: { cert: certBytes, key: keyBytes } };
}

// Invokes mkcert to issue a leaf certificate covering every one of `names` into
// `certPath`/`keyPath`. Never asks mkcert to install its CA — only `-cert-file`/`-key-file`
// plus the names themselves are ever passed.
function issueLeaf({ spawnSync, certPath, keyPath, names }) {
  let result;
  try {
    result = spawnSync('mkcert', ['-cert-file', certPath, '-key-file', keyPath, ...names], {
      encoding: 'utf8',
    });
  } catch (error) {
    return { ok: false, reason: `mkcert failed to run: ${error.message}` };
  }
  if (!result || result.error) {
    return {
      ok: false,
      reason: `mkcert failed to run: ${result?.error?.message ?? 'mkcert did not run'}`,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `mkcert exited with status ${result.status}: ${(result.stderr ?? '').trim()}`,
    };
  }
  return { ok: true };
}

// Reads back the leaf certificate/key mkcert just claimed to have written. A claimed
// success (exit 0) whose output files cannot actually be read is reported as a failure
// here, not treated as success with a missing credential.
function loadIssuedCredential(certPath, keyPath, { readFile }) {
  let certBytes;
  try {
    certBytes = readFile(certPath);
  } catch (error) {
    return {
      ok: false,
      reason: `mkcert reported success but certificate file "${certPath}" could not be read: ${error.message}`,
    };
  }
  let keyBytes;
  try {
    keyBytes = readFile(keyPath);
  } catch (error) {
    return {
      ok: false,
      reason: `mkcert reported success but key file "${keyPath}" could not be read: ${error.message}`,
    };
  }
  return { ok: true, credential: { cert: certBytes, key: keyBytes } };
}

// Issues (or reuses) a leaf certificate from an existing mkcert local CA and reports that
// CA's root as the anchor. Returns `{ ok: true, credential, anchor, warnings: [] }` or
// `{ ok: false, reason }`; never throws.
//
// Order of operations matters for one guarantee in particular: the credential (reused or
// freshly issued) is resolved *before* the anchor is looked up, but never returned until
// the anchor lookup also succeeds. A successfully issued leaf whose CA root cannot be
// found is discarded, not handed back with `anchor: undefined` — a credential with no
// anchor would leave enrolling devices with nothing to trust, silently.
export function provision(
  settings,
  {
    spawnSync = childProcessSpawnSync,
    readFile = readFileSync,
    mkdir = mkdirSync,
    localAddresses = discoverLocalAddresses,
    certificateDirectory = defaultCertificateDirectory,
    now,
  } = {},
) {
  const stateDir = certificateDirectory();
  const certPath = join(stateDir, 'cert.pem');
  const keyPath = join(stateDir, 'key.pem');

  const addresses = localAddresses();
  const names = [...addresses.hostnames, ...addresses.ips];

  const reused = tryReuseExisting(certPath, keyPath, { readFile, addresses, now });

  let credential;
  if (reused) {
    credential = reused.credential;
  } else {
    try {
      mkdir(stateDir, { recursive: true });
    } catch (error) {
      return {
        ok: false,
        reason: `could not create TLS state directory "${stateDir}": ${error.message}`,
      };
    }

    const issued = issueLeaf({ spawnSync, certPath, keyPath, names });
    if (!issued.ok) return issued;

    const loaded = loadIssuedCredential(certPath, keyPath, { readFile });
    if (!loaded.ok) return loaded;
    credential = loaded.credential;
  }

  const anchorResult = locateCaRootAnchor({ spawnSync, readFile });
  if (!anchorResult.ok) return anchorResult;

  return { ok: true, credential, anchor: anchorResult.anchor, warnings: [] };
}

// The stable strategy object Task 7 selects between, matching `providedStrategy` (Task 4)
// and `windowsSelfSignedStrategy` (Task 6).
export const mkcertStrategy = { name, isAvailable, provision };
