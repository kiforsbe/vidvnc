import { readFile as nodeReadFile } from 'node:fs/promises';
import { defaultTlsSettings, validateTlsSettings } from './tls-settings.mjs';

// Reads and validates the TLS settings file for startup. Never throws, and every outcome
// that leaves the product without TLS is reported through `log`, because a failure that
// leaves HTTPS unavailable must be visible even when server startup continues.
//
// The three cases differ on purpose:
//   - A MISSING file means nobody has configured TLS: use the `auto` defaults, which is
//     the product's out-of-the-box behaviour.
//   - A file that exists but cannot be used (unreadable, not JSON, failing validation, or
//     naming the plaintext port) means someone configured *something* and it is wrong.
//     Guessing what they meant, by silently running `auto` in its place, could provision
//     and serve a certificate the operator never asked for — so the safe reading is "no
//     TLS this run", with HTTP viewer access disabled and the reason logged.
//   - The `auto` defaults are checked against the live plaintext port too. `VIDVNC_PORT`
//     can be set to the default TLS port, and binding TLS there first would leave the
//     HTTPS and local HTTP listeners in conflict.
//
// `plaintextPort` is the live, possibly env-overridden plaintext port. `readFile` and `log`
// are injectable for tests.
export async function loadTlsSettings(
  path,
  { plaintextPort, readFile = nodeReadFile, log = (message) => console.error(message) },
) {
  // `invalid` marks this as "off because the settings could not be used", never a deliberate
  // `off`: a validated file saying `mode: off` returns from validateTlsSettings below without
  // ever passing through here. desktop-status.mjs reads the flag to avoid telling an operator
  // with a broken file that HTTPS is deliberately disabled.
  const off = () => ({ ...defaultTlsSettings(), mode: 'off', invalid: true });
  const clash = (port) =>
    `TLS port ${port} is the same as the plaintext port ${plaintextPort}. HTTPS is unavailable and HTTP viewer access is disabled for this run; ` +
    `change the TLS port in "${path}" or VIDVNC_PORT.`;

  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      const defaults = defaultTlsSettings();
      if (defaults.port === plaintextPort) {
        log(clash(defaults.port));
        return off();
      }
      return defaults;
    }
    log(
      `Could not read TLS settings "${path}" (${error.message}). HTTPS is unavailable and HTTP viewer access is disabled for this run.`,
    );
    return off();
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
    return validateTlsSettings(parsed, { plaintextPort });
  } catch (error) {
    const port = parsed?.port ?? defaultTlsSettings().port;
    if (parsed && typeof parsed === 'object' && port === plaintextPort) {
      log(clash(port));
    } else {
      log(
        `TLS settings in "${path}" are invalid (${error.message}). HTTPS is unavailable and HTTP viewer access is disabled for this run.`,
      );
    }
    return off();
  }
}

// Reads and validates the TLS settings file for CLI status reporting (the offline `tls`
// status command, and the live `tls` status command's on-disk read for drift detection) —
// NOT for startup. `loadTlsSettings` above exists to keep the SERVER running safely:
// "never leave TLS in a broken state, disable HTTP viewer admission, log it." Reusing that same
// graceful fallback for a command whose entire job is to answer "what does my TLS
// configuration look like right now" would be actively wrong: a corrupt or invalid file
// would silently read back as "TLS mode: Off", which looks exactly like a deliberate,
// healthy configuration and hides the very problem an operator runs this command to
// diagnose.
//
// So this reads the raw file itself, with only one case reading as the `auto` defaults:
// the file is genuinely absent (ENOENT), which really does mean nobody has configured TLS
// yet. Every other failure — unreadable, not JSON, failing validateTlsSettings' shape
// checks, or a port that collides with the live plaintext port (validateTlsSettings
// already checks this, given the right `plaintextPort`) — comes back as
// `{ ...defaultTlsSettings(), invalid: <reason> }`, where `invalid` is a short, path-free
// reason a caller shows distinctly from any real mode. Never throws.
export async function readTlsSettingsStatus(path, { plaintextPort, readFile = nodeReadFile } = {}) {
  let raw;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { ...defaultTlsSettings(), invalid: null };
    return {
      ...defaultTlsSettings(),
      invalid: `the TLS settings file could not be read (${error.code ?? error.message})`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ...defaultTlsSettings(),
      invalid: `the TLS settings file is not valid JSON (${error.message})`,
    };
  }
  try {
    return { ...validateTlsSettings(parsed, { plaintextPort }), invalid: null };
  } catch (error) {
    return { ...defaultTlsSettings(), invalid: error.message };
  }
}
