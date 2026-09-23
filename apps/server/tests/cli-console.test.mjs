import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { StreamPolicyStore } from '../src/stream-policy-store.mjs';
import { createTlsListener } from '../src/tls/listener.mjs';
import { defaultTlsSettings } from '../src/tls/tls-settings.mjs';
import { liveConsole as harness } from './fixtures/cli-live-console.mjs';

// Real TLS listener built the same way tests/tls/listener.test.mjs does: a real https.Server
// bound to an ephemeral loopback port, with the certificate orchestration faked so nothing
// here ever reaches real mkcert or Windows certificate tooling, and the committed `valid`
// PEM fixture as the credential so report()'s strategy/fingerprint/expiry are real values.
const fixture = (relativePath) =>
  fileURLToPath(new URL(`./fixtures/tls/${relativePath}`, import.meta.url));
const VALID = {
  cert: readFileSync(fixture('valid/cert.pem')),
  key: readFileSync(fixture('valid/key.pem')),
};
const validAnchor = new X509Certificate(VALID.cert);
const validFingerprint = validAnchor.fingerprint256;

async function bindTlsListener(t, { ok = true } = {}) {
  const listener = createTlsListener({
    settings: { ...defaultTlsSettings(), port: 0 },
    requestListener: () => {},
    host: '127.0.0.1',
    ensureCertificate: () =>
      ok
        ? {
            ok: true,
            attempted: true,
            strategy: 'mkcert',
            credential: VALID,
            anchor: validAnchor,
            warnings: [],
            reasons: [],
            reason: null,
          }
        : {
            ok: false,
            attempted: true,
            strategy: null,
            credential: null,
            anchor: null,
            reason: 'no strategy available',
          },
    log: () => {},
  });
  await listener.attempt();
  t.after(() => listener.close());
  return listener;
}

test('live policy changes ask before disconnecting devices; declining keeps settings', async (t) => {
  const h = await harness(t);
  h.connect('192.168.1.20', 'Mozilla/5.0 (iPhone)');
  await h.send(
    'audio off',
    /^Turn desktop audio off: 1 connected device will be disconnected\. Apply\? \[y\/N\] $/,
  );
  await h.send('n', /^No changes applied\.\n$/);
  assert.equal(h.policy.snapshot().allowAudio, true);
  assert.equal(h.sessionStore.list().length, 1);
  await h.send('audio off', /\[y\/N\] $/);
  await h.send('YES', /^Desktop audio is now off\.\n$/);
  assert.equal(h.policy.snapshot().allowAudio, false);
  assert.equal(h.sessionStore.list().length, 0);
  assert.deepEqual(h.calls, [['shutdown']]);
});

test('--yes skips the question, and nobody connected means no question', async (t) => {
  const h = await harness(t);
  const quiet = await h.send(
    'client-mode options',
    /Client customization is now Approved options\.\n$/,
  );
  assert.equal(quiet.includes('[y/N]'), false);
  h.connect('192.168.1.30', 'Mozilla/5.0 (Windows NT 10.0)');
  const skipped = await h.send(
    'profile disable mobile --yes',
    /Profile "Mobile" is now hidden\.\n$/,
  );
  assert.equal(skipped.includes('[y/N]'), false);
  assert.equal(h.sessionStore.list().length, 0);
});

test('end of input at the question applies nothing', async (t) => {
  const h = await harness(t);
  h.connect('192.168.1.20', 'Mozilla/5.0 (iPhone)');
  await h.send('share 2 on', /\[y\/N\] $/);
  h.end();
  await h.done;
  assert.match(h.all(), /\[y\/N\] \nNo changes applied\.\n$/);
  assert.equal(h.policy.snapshot().displaySharing, null);
});

test('access and profile order save without disconnecting devices', async (t) => {
  const h = await harness(t);
  h.connect('192.168.1.20', 'Mozilla/5.0 (iPhone)');
  const saved = await h.send(
    'access available',
    /^Keyboard and mouse for new connections: Allow when available\n$/,
  );
  assert.equal(saved.includes('[y/N]'), false);
  assert.equal(h.access.snapshot().defaultControl, 'available');
  await h.send('profile move balanced 1', /^Moved "Balanced" to position 1\.\n$/);
  assert.equal(h.sessionStore.list().length, 1);
});

test('session commands use console numbers and stream IDs and never print session IDs', async (t) => {
  const h = await harness(t);
  const phone = h.connect('192.168.1.20', 'Mozilla/5.0 (iPhone)');
  const laptop = h.connect('192.168.1.30', 'Mozilla/5.0 (Windows NT 10.0)');
  h.streams.set(phone, [
    {
      id: 'stream-a',
      name: 'Main',
      width: 1280,
      height: 720,
      targetFps: 15,
      profile: 'iphone-720p-test',
    },
  ]);
  const list = await h.send('sessions', /Waiting for a display stream\.\n$/);
  assert.equal(
    list,
    [
      '#1  iPhone · 192.168.1.20 · Smooth · audio on · view only',
      '    Stream    Display  Size      Target  Profile           Codec  Shared',
      '    stream-a  Main     1280×720  15 fps  iphone-720p-test',
      '#2  Windows browser · 192.168.1.30 · Smooth · audio on · view only',
      '    Waiting for a display stream.',
      '',
    ].join('\n'),
  );
  await h.send('grant #2', /^Device #2 has not selected a display stream yet\.\n$/);
  await h.send('grant stream-a', /^Granted control to device #1\.\n$/);
  await h.send('stop stream-a', /^Stream stopped\.\n$/);
  await h.send('revoke', /^Control revoked\.\n$/);
  await h.send('revoke #1', /^Revoked control from device #1\.\n$/);
  await h.send('disconnect #2', /^Disconnected device #2\.\n$/);
  await h.send('disconnect #2', /^No connected device matches #2\. Use sessions to list them\.\n$/);
  await h.send('show', /^show is only available as config show\. Type help show\.\n$/);
  await h.send(
    'info',
    /Password\s+[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}\n/,
  );
  assert.deepEqual(h.calls, [
    ['command', { action: 'grant', sessionId: phone }],
    ['command', { action: 'stop-stream', sessionId: phone, streamId: 'stream-a' }],
    ['revoke-all'],
    ['command', { action: 'revoke', sessionId: phone }],
    ['stopSession', laptop],
  ]);
  assert.equal(h.all().includes(phone), false);
  assert.equal(h.all().includes(laptop), false);
});

test('a settings file changed elsewhere asks for a restart', async (t) => {
  const h = await harness(t);
  const other = await StreamPolicyStore.open(h.policyFile);
  await other.replace({ ...other.snapshot(), allowAudio: false }, 0);
  await h.send(
    'audio off',
    /^Configuration changed on disk; reload before saving\. Restart the server to reload settings\.\n$/,
  );
});

test('a no-op policy edit is applied without asking or disconnecting anyone', async (t) => {
  const h = await harness(t);
  h.connect('192.168.1.20', 'Mozilla/5.0 (iPhone)');
  const revision = h.policy.snapshot().revision;
  const result = await h.send('audio on', /^Desktop audio is now on\.\n$/);
  assert.equal(result.includes('[y/N]'), false);
  assert.equal(h.policy.snapshot().allowAudio, true);
  assert.equal(h.policy.snapshot().revision, revision);
  assert.equal(h.sessionStore.list().length, 1);
});

test('an edit the validator rejects fails before any question', async (t) => {
  const h = await harness(t);
  await h.send('default-profile desktop', /^The host default profile is now "Desktop"\.\n$/);
  h.connect('192.168.1.20', 'Mozilla/5.0 (iPhone)');
  const result = await h.send('profile disable desktop', /change the default first/);
  assert.equal(result.includes('[y/N]'), false);
  assert.equal(h.sessionStore.list().length, 1);
});

test('close drops queued input and ends the loop after the current command', async (t) => {
  const h = await harness(t);
  h.connect('192.168.1.20', 'Mozilla/5.0 (iPhone)');
  await h.send(
    'audio off',
    /^Turn desktop audio off: 1 connected device will be disconnected\. Apply\? \[y\/N\] $/,
  );
  // Several lines arrive in one chunk, including an answer and a further command, right
  // as close() is called: none of them should ever be processed.
  h.write('y\nsessions\n');
  h.close();
  await h.done;
  assert.match(h.all(), /\[y\/N\] \nNo changes applied\.\n$/);
  assert.equal(h.policy.snapshot().allowAudio, true);
  assert.equal(h.sessionStore.list().length, 1);
  assert.equal(h.all().includes('view only'), false);
});

test('disconnect resolves a device by one of its stream IDs', async (t) => {
  const h = await harness(t);
  const phone = h.connect('192.168.1.20', 'Mozilla/5.0 (iPhone)');
  h.streams.set(phone, [
    {
      id: 'stream-a',
      name: 'Main',
      width: 1280,
      height: 720,
      targetFps: 15,
      profile: 'iphone-720p-test',
    },
  ]);
  await h.send('disconnect stream-a', /^Disconnected device #1\.\n$/);
  assert.equal(h.sessionStore.list().length, 0);
  assert.deepEqual(h.calls, [['stopSession', phone]]);
  assert.equal(h.all().includes(phone), false);
});

test('exit and quit stop the server, asking first when devices are connected', async (t) => {
  const quiet = await harness(t);
  await quiet.send('exit', /^Stopping sharing…\n$/);
  await quiet.done;
  assert.equal(quiet.stops(), 1);

  const h = await harness(t);
  h.connect('192.168.1.20', 'Mozilla/5.0 (iPhone)');
  await h.send('quit', /^Stop sharing\? 1 connected device will be disconnected\. \[y\/N\] $/);
  await h.send('n', /^Still sharing\.\n$/);
  assert.equal(h.stops(), 0);
  await h.send('exit now', /^Wrong number of arguments\. Type help exit\.\n$/);
  await h.send('quit --yes', /^Stopping sharing…\n$/);
  await h.done;
  assert.equal(h.stops(), 1);
  assert.equal(h.sessionStore.list().length, 1);
});

test('live tls status reports the real strategy, fingerprint and expiry, with no restart note when the saved port matches', async (t) => {
  const listener = await bindTlsListener(t);
  const boundPort = listener.status().port;
  const h = await harness(t, { tlsListener: listener });
  await writeFile(
    join(h.directory, 'tls-settings.json'),
    JSON.stringify({
      mode: 'auto',
      port: boundPort,
      certificatePath: null,
      keyPath: null,
      pfxPath: null,
      pfxPassphrase: null,
    }),
  );
  const text = await h.send('tls', /Fingerprint:/);
  assert.match(text, /^TLS mode: Automatic$/m);
  assert.match(text, new RegExp(`^TLS port: ${boundPort}$`, 'm'));
  assert.match(text, /^Active: yes, on port \d+$/m);
  assert.match(text, /^Strategy: mkcert$/m);
  assert.match(text, new RegExp(`^Fingerprint: ${validFingerprint}$`, 'm'));
  assert.match(text, /^Certificate expires: 2036-09-21T/m);
  assert.equal(text.includes('restart'), false);
});

test('live tls status says a restart is needed when the saved settings differ from what is running', async (t) => {
  const listener = await bindTlsListener(t);
  const boundPort = listener.status().port;
  const h = await harness(t, { tlsListener: listener });
  await writeFile(
    join(h.directory, 'tls-settings.json'),
    JSON.stringify({
      mode: 'auto',
      port: boundPort + 1 === 65536 ? boundPort - 1 : boundPort + 1,
      certificatePath: null,
      keyPath: null,
      pfxPath: null,
      pfxPassphrase: null,
    }),
  );
  const text = await h.send('tls', /restart the server to apply/);
  assert.match(text, /restart the server to apply any changes\.\n$/);
});

test('live tls status shows the failure reason when nothing is serving TLS', async (t) => {
  const listener = await bindTlsListener(t, { ok: false });
  const h = await harness(t, { tlsListener: listener });
  const text = await h.send('tls', /Not serving TLS/);
  assert.match(text, /^Active: no$/m);
  assert.match(text, /^Not serving TLS: no strategy available$/m);
});

test('live tls status reports a corrupt on-disk file as invalid, not as Off, alongside what is actually running', async (t) => {
  const listener = await bindTlsListener(t);
  const h = await harness(t, { tlsListener: listener });
  await writeFile(join(h.directory, 'tls-settings.json'), '{ not json');
  const text = await h.send('tls', /TLS settings file is invalid/);
  assert.equal(text.includes('TLS mode: Off'), false);
  assert.match(text, /^Strategy: mkcert$/m);
  assert.match(text, /^Fix the settings file and restart the server/m);
});
