// The "self-signed" certificate-provisioning strategy: the portable counterpart of
// `windows-self-signed.mjs`, and the last resort on every platform but Windows (decision D7
// of the macOS design). When the operator has brought no certificate (`provided.mjs`) and
// has no mkcert installation (`mkcert.mjs`), VidVNC issues its own certificate here, with
// node:crypto and a small DER writer (`../der.mjs`) instead of an operating-system tool.
//
// Same strategy shape as its siblings: `name`, `isAvailable(settings, deps)` and a
// synchronous, never-throwing `provision(settings, deps)` returning
// `{ ok: true, credential, anchor, warnings: [] }` or `{ ok: false, reason }`.
//
// It follows `windows-self-signed` wherever the two could differ in what a device sees:
// subject CN=VidVNC, every current hostname and IP address in the subject alternative name
// (IPs as genuine IP entries), two years' validity, and reuse until `certificate-facts.mjs`
// says it is expiring, expired or no longer covers an address. The leaf is its own anchor,
// so every reissue means devices must install it again; reuse across restarts matters.
//
// The key is a P-256 key in PEM, in `key.pem` with mode 0600 in a directory with mode 0700,
// next to `cert.pem`: the same trust boundary as mkcert's `key.pem`. Moving it into the
// Keychain is later hardening. Files are written to a temporary name and renamed, so a
// crash never leaves half a key.
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import {
  X509Certificate,
  createHash,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from 'node:crypto';
import { isIP } from 'node:net';
import { dirname, join } from 'node:path';
import { domainToASCII } from 'node:url';
import { checkCoverage, renewalStatus } from '../certificate-facts.mjs';
import { localAddresses as discoverLocalAddresses } from '../local-addresses.mjs';
import { dataDirectory } from '../../paths.mjs';
import * as der from '../der.mjs';

export const name = 'self-signed';

export const VALIDITY_DAYS = 730;
// Devices whose clock runs a little behind still accept a certificate issued just now.
const BACKDATE_MS = 5 * 60 * 1000;
const SUBJECT = 'VidVNC';

const OIDS = {
  ecPublicKey: '1.2.840.10045.2.1',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  subjectKeyIdentifier: '2.5.29.14',
  keyUsage: '2.5.29.15',
  subjectAltName: '2.5.29.17',
  authorityKeyIdentifier: '2.5.29.35',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
};

function defaultCertificateDirectory() {
  return join(dataDirectory(), 'tls', 'self-signed');
}

// Available everywhere but Windows, which keeps `windows-self-signed` unchanged.
export function isAvailable(settings, { platform = process.platform } = {}) {
  return platform !== 'win32';
}

// An address as the bytes of an iPAddress general name: 4 bytes for IPv4, 16 for IPv6.
export function ipBytes(address) {
  const family = isIP(address);
  if (family === 4) return Buffer.from(address.split('.').map(Number));
  if (family !== 6) throw new Error(`Not an IP address: ${address}`);
  let text = address;
  let tail = [];
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    tail = [...ipBytes(v4[1])];
    text = text.slice(0, -v4[1].length) + '0:0';
  }
  const [head, rest] = text.split('::');
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const words =
    rest === undefined
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  const bytes = Buffer.alloc(16);
  words.forEach((word, index) => bytes.writeUInt16BE(parseInt(word, 16), index * 2));
  if (tail.length) Buffer.from(tail).copy(bytes, 12);
  return bytes;
}

const extension = (id, value, critical = false) =>
  der.sequence(der.oid(id), ...(critical ? [der.boolean(true)] : []), der.octetString(value));

// Builds and signs the certificate. Returns `{ certificate, keyPem, certPem }`; throws only
// on a programming error, which `provision` turns into a reason.
export function issueCertificate(
  { hostnames, ips },
  { now = new Date(), generateKeyPair = generateKeyPairSync, serial = randomBytes(16) } = {},
) {
  const { publicKey, privateKey } = generateKeyPair('ec', { namedCurve: 'prime256v1' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  // RFC 5280 4.2.1.2 method 1: SHA-1 of the subjectPublicKey bits (the last 65 bytes of a
  // P-256 SubjectPublicKeyInfo are the uncompressed point).
  const keyId = createHash('sha1')
    .update(spki.subarray(spki.length - 65))
    .digest();
  const names = [
    ...hostnames
      .map((hostname) => domainToASCII(hostname))
      .filter(Boolean)
      .map((hostname) => der.implicit(2, der.ia5String(hostname))),
    ...ips.map((ip) => der.implicit(7, der.octetString(ipBytes(ip)))),
  ];
  const algorithm = der.sequence(der.oid(OIDS.ecdsaWithSha256));
  const subject = der.sequence(
    der.set(der.sequence(der.oid(OIDS.commonName), der.utf8String(SUBJECT))),
  );
  const notBefore = new Date(now.getTime() - BACKDATE_MS);
  const notAfter = new Date(now.getTime() + VALIDITY_DAYS * 24 * 60 * 60 * 1000);
  // A positive serial of at most 16 bytes (RFC 5280 4.1.2.2) that is never zero.
  const serialBytes = Buffer.from(serial);
  serialBytes[0] = (serialBytes[0] & 0x7f) | 0x01;
  const tbs = der.sequence(
    der.explicit(0, der.integer(2)),
    der.integer(serialBytes),
    algorithm,
    subject,
    der.sequence(der.time(notBefore), der.time(notAfter)),
    subject,
    spki,
    der.explicit(
      3,
      der.sequence(
        extension(OIDS.keyUsage, der.namedBits([0]), true),
        extension(OIDS.extKeyUsage, der.sequence(der.oid(OIDS.serverAuth))),
        extension(OIDS.subjectAltName, der.sequence(...names)),
        extension(OIDS.subjectKeyIdentifier, der.octetString(keyId)),
        extension(
          OIDS.authorityKeyIdentifier,
          der.sequence(der.implicit(0, der.octetString(keyId))),
        ),
      ),
    ),
  );
  const signature = sign('sha256', tbs, privateKey);
  const certDer = der.sequence(tbs, algorithm, der.bitString(signature));
  const certPem = `-----BEGIN CERTIFICATE-----\n${certDer
    .toString('base64')
    .match(/.{1,64}/g)
    .join('\n')}\n-----END CERTIFICATE-----\n`;
  const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  return { certificate: new X509Certificate(certPem), certPem, keyPem };
}

// Writes `contents` to `path` through a temporary file in the same directory, with `mode`.
function writeAtomically(path, contents, mode, fs) {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`);
  const descriptor = fs.open(temporary, 'wx', mode);
  try {
    fs.write(descriptor, contents);
  } finally {
    fs.close(descriptor);
  }
  try {
    fs.chmod(temporary, mode);
    fs.rename(temporary, path);
  } catch (error) {
    try {
      fs.unlink(temporary);
    } catch {
      // Nothing more to do; the error below says what failed.
    }
    throw error;
  }
}

// The existing certificate and key, when they still match each other, cover every current
// address and are outside the renewal window; otherwise null, never an error.
function tryReuseExisting(certPath, keyPath, { fs, addresses, now }) {
  let certificate;
  let certBytes;
  let keyBytes;
  try {
    certBytes = fs.readFile(certPath);
    keyBytes = fs.readFile(keyPath);
    certificate = new X509Certificate(certBytes);
    if (!certificate.checkPrivateKey(createPrivateKey(keyBytes))) return null;
  } catch {
    return null;
  }
  // IMPORTANT: check `expired || needsRenewal`, never `needsRenewal` alone — see
  // certificate-facts.mjs's doc comment on `renewalStatus`.
  const status = renewalStatus(certificate, now ? { now } : undefined);
  if (status.expired || status.needsRenewal) return null;
  if (!checkCoverage(certificate, addresses).covered) return null;
  return { certificate, credential: { cert: certBytes, key: keyBytes } };
}

// Issues (or reuses) the self-signed leaf. `force` (the host's regenerate action) skips
// reuse for this one call.
export function provision(
  settings,
  {
    readFile = readFileSync,
    mkdir = mkdirSync,
    chmod = chmodSync,
    open = openSync,
    write = writeSync,
    close = closeSync,
    rename = renameSync,
    unlink = unlinkSync,
    localAddresses = discoverLocalAddresses,
    certificateDirectory = defaultCertificateDirectory,
    dataRoot = dataDirectory,
    generateKeyPair = generateKeyPairSync,
    platform = process.platform,
    force = false,
    now,
  } = {},
) {
  if (!isAvailable(settings, { platform }))
    return {
      ok: false,
      reason: `the self-signed strategy is not used on this platform ("${platform}")`,
    };
  const fs = { readFile, open, write, close, chmod, rename, unlink };
  const stateDir = certificateDirectory();
  const certPath = join(stateDir, 'cert.pem');
  const keyPath = join(stateDir, 'key.pem');
  const addresses = localAddresses();

  // The settings folder, its tls folder and this one are the user's alone.
  try {
    mkdir(stateDir, { recursive: true, mode: 0o700 });
    for (const directory of new Set([dataRoot(), dirname(stateDir), stateDir]))
      chmod(directory, 0o700);
  } catch (error) {
    return {
      ok: false,
      reason: `could not create TLS state directory "${stateDir}": ${error.message}`,
    };
  }

  const reused = force ? null : tryReuseExisting(certPath, keyPath, { fs, addresses, now });
  if (reused) {
    try {
      chmod(keyPath, 0o600);
    } catch (error) {
      return { ok: false, reason: `could not restrict "${keyPath}": ${error.message}` };
    }
    return { ok: true, credential: reused.credential, anchor: reused.certificate, warnings: [] };
  }

  let issued;
  try {
    issued = issueCertificate(addresses, { now: now ? now() : new Date(), generateKeyPair });
  } catch (error) {
    return { ok: false, reason: `could not create a certificate: ${error.message}` };
  }
  try {
    // The key first: a certificate without its key is never left as the newer file.
    writeAtomically(keyPath, issued.keyPem, 0o600, fs);
    writeAtomically(certPath, issued.certPem, 0o644, fs);
  } catch (error) {
    return { ok: false, reason: `could not save the certificate: ${error.message}` };
  }
  return {
    ok: true,
    credential: { cert: Buffer.from(issued.certPem), key: Buffer.from(issued.keyPem) },
    anchor: issued.certificate,
    warnings: [],
  };
}

export const selfSignedStrategy = { name, isAvailable, provision };
