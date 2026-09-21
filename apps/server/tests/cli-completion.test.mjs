import test from 'node:test';
import assert from 'node:assert/strict';
import { complete } from '../src/cli/completion.mjs';
import { SessionNumbers } from '../src/cli/resolve.mjs';
import { displayRows } from './fixtures/cli-displays.mjs';

const SESSION_ID = 'secret-session-id';

function context() {
  return {
    mode: 'live',
    policy: () => ({
      profiles: [{ id: 'balanced' }, { id: 'desktop' }, { id: 'mobile' }],
      allowedOptions: {
        resolutions: [{ width: 1920, height: 1080 }],
        frameRates: [30, 60],
        bitratesKbps: [4000],
      },
    }),
    displays: async () => displayRows(),
    sessions: {
      numbers: new SessionNumbers(),
      status: () => ({
        sessions: [{ id: SESSION_ID, streams: [{ id: 'stream-a' }] }],
      }),
    },
  };
}

const matches = async (line) => (await complete(context(), line))[0];

test('command names complete, including two-word commands, for the live console', async () => {
  const all = await matches('');
  assert.ok(all.includes('profile') && all.includes('exit') && all.includes('quit'));
  assert.equal(all.includes('show'), false);
  assert.deepEqual(await complete(context(), 'pro'), [['profile', 'profiles'], 'pro']);
  assert.deepEqual(await complete(context(), 'gr'), [['grant '], 'gr']);
  assert.deepEqual(await matches('profile d'), ['disable', 'duplicate']);
  assert.deepEqual(await matches('options '), ['add', 'remove']);
  assert.deepEqual(await matches('help profile m'), ['move ']);
  assert.deepEqual(await matches('frobnicate '), []);
});

test('arguments complete from displays, profiles and fixed words', async () => {
  assert.deepEqual(await matches('share '), ['1', '2', '3']);
  assert.deepEqual(await complete(context(), 'share 2 o'), [['on', 'off'], 'o']);
  assert.deepEqual(await matches('display-default 1 '), ['balanced', 'desktop', 'mobile', 'host']);
  assert.deepEqual(await matches('default-profile '), ['auto', 'balanced', 'desktop', 'mobile']);
  assert.deepEqual(await matches('profile disable m'), ['mobile ']);
  assert.deepEqual(await matches('profile move mobile '), ['up', 'down']);
  assert.deepEqual(await matches('access a'), ['approval', 'available']);
  assert.deepEqual(await matches('client-mode '), ['profiles', 'options']);
  assert.deepEqual(await matches('options remove '), ['size', 'framerate', 'bitrate']);
  assert.deepEqual(await matches('options remove framerate '), ['30', '60']);
  assert.deepEqual(await matches('options remove size '), ['1920x1080 ']);
  assert.deepEqual(await matches('audio on '), []);
  assert.deepEqual(await matches('profile add "My '), []);
});

test('rate control flags complete their values', async () => {
  assert.deepEqual(await matches('profile edit mobile --bitrate-mode '), ['cbr', 'vbr']);
  assert.deepEqual(await matches('profile add Sharp --quality '), [
    'efficient',
    'balanced',
    'high',
  ]);
  assert.deepEqual(await matches('profile edit mobile --bitrate-mode v'), ['vbr ']);
});

test('devices complete as console numbers and stream IDs, never session IDs', async () => {
  assert.deepEqual(await matches('grant '), ['#1', 'stream-a']);
  assert.deepEqual(await matches('disconnect #'), ['#1 ']);
  assert.deepEqual(await matches('stop '), ['stream-a ']);
  const everything = [];
  for (const line of ['', 'grant ', 'revoke ', 'disconnect ', 'stop ', 'help '])
    everything.push(...(await matches(line)));
  assert.equal(
    everything.some((word) => word.includes(SESSION_ID)),
    false,
  );
});

test('flags complete for the command, skipping ones already given and flag values', async () => {
  assert.deepEqual(await matches('audio off --'), ['--yes ']);
  assert.deepEqual(await matches('profile move mobile --'), []);
  assert.deepEqual(await matches('profile edit mobile --s'), ['--size ']);
  assert.deepEqual(await matches('profile edit mobile --size '), []);
  assert.deepEqual(await matches('profile edit mobile --size 1280x720 --'), [
    '--description',
    '--fps',
    '--bitrate',
    '--bitrate-mode',
    '--quality',
    '--name',
    '--enabled',
    '--disabled',
    '--yes',
  ]);
});

test('the encoder backend completes to exactly the allowed values', async () => {
  const [values] = await complete(context(), 'encoder-backend ');
  assert.deepEqual(values, ['auto', 'nvenc', 'qsv', 'amf', 'mediafoundation']);
  assert.deepEqual(await complete(context(), 'encoder-b'), [['encoder-backend '], 'encoder-b']);
});
