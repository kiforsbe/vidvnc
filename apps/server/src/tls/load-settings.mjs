import { readFile as nodeReadFile } from 'node:fs/promises';
import { defaultTlsSettings, validateTlsSettings } from './tls-settings.mjs';

// Reads and validates the TLS settings file for startup. Never throws, and every outcome
// that leaves the product without TLS is reported through `log`, because a failure that
// leaves the product plaintext must be visible even when it is not fatal.
//
// The three cases differ on purpose:
//   - A MISSING file means nobody has configured TLS: use the `auto` defaults, which is
//     the product's out-of-the-box behaviour.
//   - A file that exists but cannot be used (unreadable, not JSON, failing validation, or
//     naming the plaintext port) means someone configured *something* and it is wrong.
//     Guessing what they meant, by silently running `auto` in its place, could provision
//     and serve a certificate the operator never asked for — so the safe reading is "no
//     TLS this run", plaintext only, with the reason logged.
//   - The `auto` defaults are checked against the live plaintext port too. `VIDVNC_PORT`
//     can be set to the default TLS port, and binding TLS there first would leave the
//     plaintext listener with EADDRINUSE, which stops the whole server.
//
// `plaintextPort` is the live, possibly env-overridden plaintext port. `readFile` and `log`
// are injectable for tests.
export async function loadTlsSettings(
  path,
  { plaintextPort, readFile = nodeReadFile, log = (message) => console.error(message) },
) {
  const off = () => ({ ...defaultTlsSettings(), mode: 'off' });
  const clash = (port) =>
    `TLS port ${port} is the same as the plaintext port ${plaintextPort}. TLS is disabled for this run and the server is plaintext only; ` +
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
      `Could not read TLS settings "${path}" (${error.message}). TLS is disabled for this run and the server is plaintext only.`,
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
        `TLS settings in "${path}" are invalid (${error.message}). TLS is disabled for this run and the server is plaintext only.`,
      );
    }
    return off();
  }
}
