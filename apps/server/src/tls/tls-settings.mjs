// TLS listener settings: which mode the server runs in, which port the TLS listener uses,
// and where an operator's own certificate lives (used only in `provided` mode). Stored
// beside stream-policy.json and access-settings.json in the per-user data directory (see
// paths.mjs) — another entry in that settings map follows a pattern rather than inventing
// one.
//
// This module is pure and synchronous, matching stream-policy.mjs rather than
// access-settings.mjs: it has no file-system access of its own, and a caller that persists
// these settings owns that separately. Validation checks shape only — modes, ports, path
// types, and the mutually exclusive `provided`-mode combinations — never whether a path
// actually exists, is readable, or names a usable certificate. Keeping the filesystem out
// of this validator is what lets "malformed configuration rejected at edit time" (the
// design goal) stay a cheap, portable check; certificate loading is Task 4's job.

const MODES = Object.freeze(['auto', 'provided', 'off']);

// One above the plaintext listener's own default (4382, apps/server/src/main.mjs:93), so
// the two listeners never collide out of the box and the pair is easy to remember together.
export const DEFAULT_TLS_PORT = 4383;

// The plaintext listener's default port. Settings validation stays a pure, synchronous
// shape check rather than a live read of VIDVNC_PORT, so this is the literal default an
// operator gets today, not whatever they may have moved the plaintext port to via the
// environment.
const PLAINTEXT_PORT_DEFAULT = 4382;

const DEFAULTS = Object.freeze({
  mode: 'auto',
  port: DEFAULT_TLS_PORT,
  certificatePath: null,
  keyPath: null,
  pfxPath: null,
  pfxPassphrase: null,
});

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function path(value, label) {
  requireValue(
    value === null || (typeof value === 'string' && value.length > 0),
    `${label} must be a string path`,
  );
}

export function defaultTlsSettings() {
  return { ...DEFAULTS };
}

// Returns a clean settings object (defaults filled in, never the caller's own object) or
// throws with a message naming the specific field that failed.
export function validateTlsSettings(value) {
  requireValue(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'TLS settings must be an object',
  );
  requireValue(
    Object.keys(value).every((key) => Object.hasOwn(DEFAULTS, key)),
    'TLS settings has unknown fields',
  );
  const next = { ...DEFAULTS, ...value };

  requireValue(MODES.includes(next.mode), 'TLS mode must be auto, provided or off');
  requireValue(
    Number.isSafeInteger(next.port) && next.port >= 1 && next.port <= 65535,
    'TLS port must be an integer from 1 to 65535',
  );
  requireValue(
    next.port !== PLAINTEXT_PORT_DEFAULT,
    'TLS port must not be the same as the plaintext port',
  );
  path(next.certificatePath, 'Certificate path');
  path(next.keyPath, 'Key path');
  path(next.pfxPath, 'PFX path');
  requireValue(
    next.pfxPassphrase === null || typeof next.pfxPassphrase === 'string',
    'PFX passphrase must be a string',
  );

  if (next.mode === 'provided') {
    const hasCertificate = next.certificatePath !== null;
    const hasKey = next.keyPath !== null;
    requireValue(hasCertificate === hasKey, 'Certificate and key must be provided together');
    const hasPair = hasCertificate && hasKey;
    const hasPfx = next.pfxPath !== null;
    requireValue(
      hasPair || hasPfx,
      'Provided mode requires a certificate and key pair or a PFX file',
    );
    requireValue(
      !(hasPair && hasPfx),
      'Provide either a certificate and key pair or a PFX file, not both',
    );
    requireValue(hasPfx || next.pfxPassphrase === null, 'PFX passphrase requires a PFX file');
  } else {
    requireValue(
      next.certificatePath === null &&
        next.keyPath === null &&
        next.pfxPath === null &&
        next.pfxPassphrase === null,
      'Certificate settings are only used in provided mode',
    );
  }

  return next;
}
