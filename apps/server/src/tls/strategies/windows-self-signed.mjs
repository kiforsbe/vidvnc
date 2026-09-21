// The "windows-self-signed" certificate-provisioning strategy: the fallback of last
// resort. When the operator has brought no certificate (`provided.mjs`) and has no
// mkcert installation (`mkcert.mjs`), VidVNC issues its own self-signed credential
// through Windows certificate tooling. This is the zero-configuration default path, so
// it is the one most users actually hit.
//
// Implements the same strategy shape Task 4 (`provided.mjs`) defines: `name`,
// `isAvailable(settings, deps)`, `provision(settings, deps)`, plus a bundled
// `{ name, isAvailable, provision }` object. `provision` is synchronous, never throws,
// and returns either `{ ok: true, credential, anchor, warnings: [] }` or
// `{ ok: false, reason }`.
//
// `anchor` here is the same certificate used to build `credential`: a self-signed
// certificate is its own anchor, so there is no separate CA to hand back (contrast
// `mkcert.mjs`, where `anchor` is a different certificate, the mkcert CA root). The
// shared shape handles both without special-casing.
//
// Three facts were verified against the real tooling during this project's design, and
// this implementation depends on all three:
//   1. `New-SelfSignedCertificate` with `-TextExtension @("2.5.29.17={text}DNS=...&
//      IPAddress=...")` produces a certificate carrying genuine IP address entries in
//      the SAN, not IPs smuggled in as DNS names.
//   2. It exports to PFX via `Export-PfxCertificate`.
//   3. `node:tls` consumes that PFX directly, with no conversion to PEM. This module
//      never converts anything to PEM.
//
// Every interaction with Windows certificate tooling goes through the injected
// `spawnSync`, which defaults to `node:child_process`'s synchronous variant, mirroring
// every sibling strategy in this family (`mkcert.mjs` in particular) — `provision` stays
// synchronous, and a portable test suite must never spawn a real `powershell.exe`.
//
// Cleanup is not optional: whatever this strategy creates in the certificate store
// (`Cert:\CurrentUser\My`) during issuance is removed once exported — including its key
// container, via `-DeleteKey` — so repeated startups never accumulate certificates
// there. This removal happens on the failure path too (an export that fails still
// leaves a certificate sitting in the store unless it is cleaned up), via a JS
// `try`/`finally` around the export step, not only after a successful one.
//
// The exported PFX is reused across restarts rather than reissued every time. This
// matters more here than it does for `mkcert.mjs`: this strategy's anchor *is* the leaf
// (see above), so every reissue invalidates every device that already trusts the
// previous leaf. Reuse needs the PFX's passphrase to still exist on the next process
// start, so it is written to a plaintext sidecar file (`cert.pfx.passphrase`) next to
// `cert.pfx`, in the same per-user state directory — the same trust boundary the PFX
// itself already sits in (no different from `mkcert.mjs` storing a plaintext `key.pem`
// there). A credential is reused only when `certificate-facts.mjs` confirms it is still
// usable (not expired, not inside its renewal window, still covers every current
// address); a missing or unreadable sidecar or PFX is treated as "nothing to reuse yet",
// never as an error — a half-deleted state directory must not brick TLS.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync as childProcessSpawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { createSecureContext as nodeCreateSecureContext } from 'node:tls';
import { checkCoverage, renewalStatus } from '../certificate-facts.mjs';
import { localAddresses as discoverLocalAddresses } from '../local-addresses.mjs';
import { loadPfxCredential } from '../pfx-credential.mjs';
import { dataDirectory } from '../../paths.mjs';

export const name = 'windows-self-signed';

// The certificate store location every operation targets. `CurrentUser` (not
// `LocalMachine`) so this never requires elevation to create, export or remove.
const STORE_LOCATION = 'Cert:\\CurrentUser\\My';

// The OID for the X.509 "Subject Alternative Name" extension. `-TextExtension` is how
// `New-SelfSignedCertificate` accepts an arbitrary extension by OID plus a `{text}`
// value, which is what lets IP addresses be expressed as genuine IP-typed SAN entries
// (`IPAddress=...`) rather than DNS names that merely look like one.
const SUBJECT_ALT_NAME_OID = '2.5.29.17';

const SUBJECT = 'CN=VidVNC';
const VALIDITY_YEARS = 2;

// Where this strategy exports its freshly issued leaf. Injectable as
// `certificateDirectory` in `deps` so tests can confine every file this module touches
// to a temp directory, matching `mkcert.mjs`'s pattern.
function defaultCertificateDirectory() {
  return join(dataDirectory(), 'tls', 'windows-self-signed');
}

function defaultRandomPassphrase() {
  return randomBytes(32).toString('hex');
}

// PowerShell single-quoted string literal: no variable/expression expansion, so this is
// the safe default for embedding a path, passphrase or thumbprint we did not choose the
// contents of. A literal single quote is escaped by doubling it, PowerShell's own rule
// for single-quoted strings.
function powerShellSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// PowerShell double-quoted string literal, used only for the `-TextExtension` value
// (matching the exact `-TextExtension @("...")` shape this strategy's design depends
// on). A literal double quote is escaped by doubling it.
function powerShellDoubleQuoted(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

// Runs one PowerShell script through the injected `spawnSync` and normalizes every way
// it can fail into `{ ok: false, reason }`, preserving PowerShell's own message text.
// Never throws, even if `spawnSync` itself throws (a fake runner in tests might, and a
// real `spawnSync` can reject invalid options synchronously) — mirrors
// `mkcert.mjs`'s `runCaRoot`/`issueLeaf`.
function runPowerShell(spawnSync, script) {
  let result;
  try {
    result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
    });
  } catch (error) {
    return { ok: false, reason: `PowerShell failed to run: ${error.message}` };
  }
  if (!result || result.error) {
    return {
      ok: false,
      reason: `PowerShell failed to run: ${result?.error?.message ?? 'PowerShell did not run'}`,
    };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: `PowerShell exited with status ${result.status}: ${(result.stderr ?? '').trim()}`,
    };
  }
  return { ok: true, stdout: (result.stdout ?? '').trim() };
}

// The lightest possible probe that PowerShell itself actually resolves and runs,
// without touching the certificate store. Used by `isAvailable` only.
function probePowerShell(spawnSync) {
  return runPowerShell(spawnSync, 'exit 0');
}

// True only on Windows, and only when PowerShell itself resolves and runs. `settings` is
// accepted only so every strategy shares the same call signature (see the ruling in
// `provided.mjs`'s doc comment); this strategy does not consult it — like `mkcert.mjs`,
// its condition is an environmental probe, not a settings check. The platform check
// short-circuits before ever touching `spawnSync`, so a non-Windows caller never spawns
// anything, real or fake.
export function isAvailable(
  settings,
  { platform = process.platform, spawnSync = childProcessSpawnSync } = {},
) {
  if (platform !== 'win32') return false;
  return probePowerShell(spawnSync).ok;
}

// Builds the `-TextExtension` value carrying every discovered hostname and IP as SAN
// entries, IPs expressed as `IPAddress=` entries and never as `DNS=` entries.
function buildSanExtensionText({ hostnames, ips }) {
  const entries = [...hostnames.map((h) => `DNS=${h}`), ...ips.map((ip) => `IPAddress=${ip}`)];
  return `${SUBJECT_ALT_NAME_OID}={text}${entries.join('&')}`;
}

// Issues a fresh self-signed leaf into `Cert:\CurrentUser\My`, covering every name in
// `sanExtensionText`. Returns `{ ok: true, thumbprint }` or `{ ok: false, reason }`.
function createSelfSignedCertificate({ spawnSync, sanExtensionText }) {
  const script =
    `$cert = New-SelfSignedCertificate ` +
    `-CertStoreLocation ${powerShellSingleQuoted(STORE_LOCATION)} ` +
    `-Subject ${powerShellSingleQuoted(SUBJECT)} ` +
    `-TextExtension @(${powerShellDoubleQuoted(sanExtensionText)}) ` +
    `-KeyExportPolicy Exportable ` +
    `-KeyUsage DigitalSignature,KeyEncipherment ` +
    `-Type SSLServerAuthentication ` +
    `-NotAfter (Get-Date).AddYears(${VALIDITY_YEARS}); ` +
    `Write-Output $cert.Thumbprint`;

  const result = runPowerShell(spawnSync, script);
  if (!result.ok) return result;
  if (!result.stdout) {
    return { ok: false, reason: 'New-SelfSignedCertificate produced no thumbprint' };
  }
  return { ok: true, thumbprint: result.stdout };
}

// Exports the certificate named by `thumbprint` to a PFX at `pfxPath`, protected by
// `passphrase`. Returns `{ ok: true }` or `{ ok: false, reason }`.
function exportToPfx({ spawnSync, thumbprint, pfxPath, passphrase }) {
  const certPath = `${STORE_LOCATION}\\${thumbprint}`;
  const script =
    `$password = ConvertTo-SecureString -String ${powerShellSingleQuoted(passphrase)} -AsPlainText -Force; ` +
    `Export-PfxCertificate -Cert ${powerShellSingleQuoted(certPath)} -FilePath ${powerShellSingleQuoted(pfxPath)} -Password $password | Out-Null`;
  return runPowerShell(spawnSync, script);
}

// Removes the certificate named by `thumbprint` from the store, including its key
// container (`-DeleteKey`), so repeated startups never accumulate certificates there.
// Best-effort: this is always called from a `finally` block around the export step, and
// its own failure is not surfaced as the overall provisioning reason (the export's own
// success/failure already is) — there is nothing more useful this module can do with a
// cleanup failure than have tried.
function removeFromStore({ spawnSync, thumbprint }) {
  const certPath = `${STORE_LOCATION}\\${thumbprint}`;
  const script = `Remove-Item -Path ${powerShellSingleQuoted(certPath)} -DeleteKey -Force`;
  return runPowerShell(spawnSync, script);
}

// PFX loading/leaf-extraction is shared with `provided.mjs` via `../pfx-credential.mjs`
// (`loadPfxCredential`) — see that module for the full provenance comment on the
// undocumented internal Node API it depends on (`context.context.getCertificate()`).

// Checks whether the credential already exported into `pfxPath` (with its passphrase at
// `passphrasePath`, from a prior run of this strategy) is still usable, per
// `certificate-facts.mjs`'s documented reissue rule: reuse only when the certificate is
// neither expired nor inside its renewal window, and only when it still covers every
// currently discovered address. Returns `{ credential, certificate }` to reuse, or
// `null` when there is nothing usable yet — a missing or unreadable sidecar passphrase,
// a missing or unreadable/unopenable PFX, expiry, the renewal window, or missing
// coverage are all simply "reissue", never an error. Every read here is wrapped so a
// half-deleted state directory (PFX present but sidecar gone, or vice versa) falls
// through to `null` rather than propagating.
function tryReuseExisting(
  pfxPath,
  passphrasePath,
  { readFile, createSecureContext, addresses, now },
) {
  let passphrase;
  try {
    passphrase = readFile(passphrasePath).toString('utf8').trim();
  } catch {
    return null;
  }

  const loaded = loadPfxCredential(pfxPath, passphrase, { readFile, createSecureContext });
  if (!loaded.ok) return null;

  // IMPORTANT: check `expired || needsRenewal`, never `needsRenewal` alone — see
  // certificate-facts.mjs's doc comment on `renewalStatus`.
  const status = renewalStatus(loaded.certificate, now ? { now } : undefined);
  if (status.expired || status.needsRenewal) return null;

  const coverage = checkCoverage(loaded.certificate, addresses);
  if (!coverage.covered) return null;

  return { credential: loaded.credential, certificate: loaded.certificate };
}

// Issues (or reuses) a self-signed leaf certificate through Windows certificate tooling,
// covering every hostname/IP this machine currently reports, and reports that same leaf
// as the anchor. Returns `{ ok: true, credential, anchor, warnings: [] }` or
// `{ ok: false, reason }`; never throws.
//
// On non-Windows platforms this reports unavailable immediately, without ever touching
// `spawnSync` — TLS is an improvement, never a precondition, so a caller (Task 7) can
// walk the strategy list and fall through to plaintext without this strategy ever
// attempting to spawn a binary that could not possibly exist for it.
export function provision(
  settings,
  {
    spawnSync = childProcessSpawnSync,
    readFile = readFileSync,
    writeFile = writeFileSync,
    mkdir = mkdirSync,
    createSecureContext = nodeCreateSecureContext,
    localAddresses = discoverLocalAddresses,
    certificateDirectory = defaultCertificateDirectory,
    randomPassphrase = defaultRandomPassphrase,
    platform = process.platform,
    now,
  } = {},
) {
  if (platform !== 'win32') {
    return {
      ok: false,
      reason: `the windows-self-signed strategy is not available on this platform ("${platform}")`,
    };
  }

  const stateDir = certificateDirectory();
  const pfxPath = join(stateDir, 'cert.pfx');
  const passphrasePath = join(stateDir, 'cert.pfx.passphrase');

  const addresses = localAddresses();

  const reused = tryReuseExisting(pfxPath, passphrasePath, {
    readFile,
    createSecureContext,
    addresses,
    now,
  });
  if (reused) {
    return { ok: true, credential: reused.credential, anchor: reused.certificate, warnings: [] };
  }

  const sanExtensionText = buildSanExtensionText(addresses);

  const created = createSelfSignedCertificate({ spawnSync, sanExtensionText });
  if (!created.ok) return created;

  try {
    mkdir(stateDir, { recursive: true });
  } catch (error) {
    removeFromStore({ spawnSync, thumbprint: created.thumbprint });
    return {
      ok: false,
      reason: `could not create TLS state directory "${stateDir}": ${error.message}`,
    };
  }

  const passphrase = randomPassphrase();

  let exported;
  try {
    exported = exportToPfx({ spawnSync, thumbprint: created.thumbprint, pfxPath, passphrase });
  } finally {
    // Cleanup happens on both the success and failure paths: whatever was created above
    // is removed from the store, including its key, the moment export is done with it.
    removeFromStore({ spawnSync, thumbprint: created.thumbprint });
  }
  if (!exported.ok) return exported;

  // Persist the passphrase alongside the PFX so a future startup can reuse this exact
  // credential instead of reissuing (and re-invalidating every already-enrolled device)
  // on every restart. Best-effort: a failure to write it does not fail this call — the
  // credential just issued is still returned and used for this run. Only the *next*
  // startup degrades, to reissuing again, which is safe, not a failure of this one.
  try {
    writeFile(passphrasePath, passphrase, 'utf8');
  } catch {
    // Nothing more useful to do; see comment above.
  }

  const loaded = loadPfxCredential(pfxPath, passphrase, { readFile, createSecureContext });
  if (!loaded.ok) return loaded;

  return { ok: true, credential: loaded.credential, anchor: loaded.certificate, warnings: [] };
}

// The stable strategy object Task 7 selects between, matching `providedStrategy`
// (Task 4) and `mkcertStrategy` (Task 5).
export const windowsSelfSignedStrategy = { name, isAvailable, provision };
