import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTlsSettings } from '../../src/tls/load-settings.mjs';
import { DEFAULT_TLS_PORT, defaultTlsSettings } from '../../src/tls/tls-settings.mjs';

const PATH = 'C:\data\VidVNC\tls-settings.json';

function collectLog() {
  const lines = [];
  const log = (message) => lines.push(message);
  log.lines = lines;
  return log;
}

// A readFile that returns `text`, or fails with `code` when `text` is an error code.
const fileWith = (text) => async () => text;
const fileFailing =
  (code, message = code) =>
  async () => {
    throw Object.assign(new Error(message), { code });
  };

const load = (readFile, { plaintextPort = 4382, log = collectLog() } = {}) =>
  loadTlsSettings(PATH, { plaintextPort, readFile, log });

test('a missing settings file means nobody configured TLS: auto defaults, nothing logged', async () => {
  const log = collectLog();
  const settings = await load(fileFailing('ENOENT'), { log });
  assert.deepEqual(settings, defaultTlsSettings());
  assert.equal(settings.mode, 'auto');
  assert.deepEqual(log.lines, []);
});

test('a valid settings file is used as written', async () => {
  const settings = await load(fileWith(JSON.stringify({ mode: 'auto', port: 9443 })));
  assert.equal(settings.mode, 'auto');
  assert.equal(settings.port, 9443);
});

test('an explicit "off" in a valid file stays off', async () => {
  const settings = await load(fileWith(JSON.stringify({ mode: 'off' })));
  assert.equal(settings.mode, 'off');
});

for (const [label, text] of [
  ['malformed JSON', '{ "mode": '],
  ['a non-object', '[]'],
  ['an unknown field', JSON.stringify({ mode: 'auto', surprise: true })],
  ['an unknown mode', JSON.stringify({ mode: 'sometimes' })],
  ['an out-of-range port', JSON.stringify({ port: 70000 })],
  ['provided mode without a certificate', JSON.stringify({ mode: 'provided' })],
]) {
  test(`an invalid settings file (${label}) falls back to plaintext only, not to auto, and says why`, async () => {
    const log = collectLog();
    const settings = await load(fileWith(text), { log });
    assert.equal(settings.mode, 'off');
    assert.equal(log.lines.length, 1);
    assert.ok(log.lines[0].includes(PATH), 'the log names the file');
    assert.match(log.lines[0], /invalid/);
    assert.match(log.lines[0], /HTTP viewer.*disabled/);
  });
}

test('a settings file that exists but cannot be read is not the same as a missing one: plaintext only, logged', async () => {
  const log = collectLog();
  const settings = await load(fileFailing('EACCES', 'permission denied'), { log });
  assert.equal(settings.mode, 'off');
  assert.match(log.lines.join('\n'), /permission denied/);
  assert.match(log.lines.join('\n'), /HTTP viewer.*disabled/);
});

test('the auto defaults are validated against the live plaintext port: VIDVNC_PORT equal to the default TLS port skips TLS and names both ports', async () => {
  const log = collectLog();
  const settings = await load(fileFailing('ENOENT'), { plaintextPort: DEFAULT_TLS_PORT, log });
  assert.equal(settings.mode, 'off');
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0], new RegExp(`TLS port ${DEFAULT_TLS_PORT}`));
  assert.match(log.lines[0], new RegExp(`plaintext port ${DEFAULT_TLS_PORT}`));
  assert.match(log.lines[0], /HTTP viewer.*disabled/);
});

test('a file whose port collides with the plaintext port skips TLS and names both ports', async () => {
  const log = collectLog();
  const settings = await load(fileWith(JSON.stringify({ port: 4500 })), {
    plaintextPort: 4500,
    log,
  });
  assert.equal(settings.mode, 'off');
  assert.match(log.lines.join('\n'), /TLS port 4500/);
  assert.match(log.lines.join('\n'), /plaintext port 4500/);
});

test('a file that leaves the port out collides through the default too', async () => {
  const log = collectLog();
  const settings = await load(fileWith(JSON.stringify({ mode: 'auto' })), {
    plaintextPort: DEFAULT_TLS_PORT,
    log,
  });
  assert.equal(settings.mode, 'off');
  assert.match(log.lines.join('\n'), new RegExp(`plaintext port ${DEFAULT_TLS_PORT}`));
});
