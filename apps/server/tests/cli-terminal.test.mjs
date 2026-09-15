import test from 'node:test';
import assert from 'node:assert/strict';
import { promptState } from '../src/cli/format.mjs';
import { SessionNumbers } from '../src/cli/resolve.mjs';
import { liveConsole } from './fixtures/cli-live-console.mjs';

const UP = '\x1b[A';
const STREAM = {
  id: 'stream-a',
  name: 'Main',
  width: 1280,
  height: 720,
  targetFps: 15,
  profile: 'iphone-720p-test',
};

async function typed(t) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const h = await liveConsole(t, { terminal: true });
  const line = () => h.terminal.current();
  return {
    ...h,
    line,
    // Presses Enter after the text.
    enter: (text) => h.write(`${text}\r`),
    // Waits for the cursor's row to read exactly this.
    shows: (text) => h.until(() => line() === text),
    prompts: () => h.terminal.screen().filter((row) => row.startsWith('vidvnc [')),
  };
}

test('the prompt shows devices and control and redraws in place, keeping typed text', async (t) => {
  const h = await typed(t);
  await h.shows('vidvnc [no devices]>');
  h.write('sess');
  await h.shows('vidvnc [no devices]> sess');
  const phone = h.connect('192.168.1.20', 'Mozilla/5.0 (iPhone)');
  h.streams.set(phone, [STREAM]);
  t.mock.timers.tick(1000);
  await h.shows('vidvnc [1 device]> sess');
  assert.equal(h.terminal.column, 'vidvnc [1 device]> sess'.length);
  assert.equal(h.prompts().length, 1);
  h.enter('ions');
  await h.until(() =>
    h.terminal.screen().includes('    stream-a  Main     1280×720  15 fps  iphone-720p-test'),
  );
  h.enter('grant #1');
  await h.shows('vidvnc [1 device · #1 has control]>');
  assert.deepEqual(h.terminal.screen().slice(-3), [
    'vidvnc [1 device]> grant #1',
    'Granted control to device #1.',
    'vidvnc [1 device · #1 has control]>',
  ]);
});

test('Up recalls commands but not answers to questions', async (t) => {
  const h = await typed(t);
  h.connect('192.168.1.20', 'Mozilla/5.0 (iPhone)');
  h.enter('audio off');
  await h.shows('Turn desktop audio off: 1 connected device will be disconnected. Apply? [y/N]');
  h.enter('n');
  await h.shows('vidvnc [1 device]>');
  assert.deepEqual(h.terminal.screen().slice(-4), [
    'vidvnc [no devices]> audio off',
    'Turn desktop audio off: 1 connected device will be disconnected. Apply? [y/N] n',
    'No changes applied.',
    'vidvnc [1 device]>',
  ]);
  h.write(UP);
  await h.shows('vidvnc [1 device]> audio off');
});

test('background output appears above the prompt and the typed text is redrawn', async (t) => {
  const h = await typed(t);
  await h.shows('vidvnc [no devices]>');
  h.write('disp');
  await h.shows('vidvnc [no devices]> disp');
  h.terminal.write('[native-media stream-a] encoder started\n');
  h.terminal.write('Display refresh failed: timed out');
  await h.until(() => h.prompts().length === 1);
  assert.deepEqual(h.terminal.screen().slice(-3), [
    '[native-media stream-a] encoder started',
    'Display refresh failed: timed out',
    'vidvnc [no devices]> disp',
  ]);
  assert.equal(h.terminal.column, 'vidvnc [no devices]> disp'.length);
});

test('exit asks when devices are connected; a declined question keeps sharing', async (t) => {
  const h = await typed(t);
  h.connect('192.168.1.20', 'Mozilla/5.0 (iPhone)');
  h.enter('exit');
  await h.shows('Stop sharing? 1 connected device will be disconnected. [y/N]');
  h.enter('n');
  await h.shows('vidvnc [1 device]>');
  assert.ok(h.terminal.screen().includes('Still sharing.'));
  assert.equal(h.stops(), 0);
  h.enter('quit --yes');
  await h.done;
  assert.equal(h.stops(), 1);
  assert.deepEqual(h.terminal.screen().slice(-2), [
    'vidvnc [1 device]> quit --yes',
    'Stopping sharing…',
  ]);
});

test('Ctrl+D is ignored and Ctrl+C stops sharing', async (t) => {
  const h = await typed(t);
  await h.shows('vidvnc [no devices]>');
  h.write('\x04');
  h.enter('access');
  await h.shows('vidvnc [no devices]>');
  assert.ok(
    h.terminal.screen().includes('Keyboard and mouse for new connections: Require host approval'),
  );
  h.write('prof');
  await h.shows('vidvnc [no devices]> prof');
  h.write('\x03');
  await h.done;
  assert.equal(h.stops(), 1);
  assert.deepEqual(h.terminal.screen().slice(-2), [
    'Keyboard and mouse for new connections: Require host approval',
    'Stopping sharing…',
  ]);
  // The console no longer draws over later output.
  h.terminal.write('Stopped.\n');
  assert.equal(h.terminal.screen().at(-1), 'Stopped.');
});

test('Tab completes a command and lists device choices', async (t) => {
  const h = await typed(t);
  await h.shows('vidvnc [no devices]>');
  const phone = h.connect('192.168.1.20', 'Mozilla/5.0 (iPhone)');
  h.streams.set(phone, [STREAM]);
  t.mock.timers.tick(1000);
  h.write('gr');
  await h.shows('vidvnc [1 device]> gr');
  h.write('\t');
  await h.shows('vidvnc [1 device]> grant');
  h.write('\t');
  await h.pause(20);
  h.write('\t');
  await h.until(() => h.terminal.screen().some((row) => /^#1\s+stream-a$/.test(row)));
  await h.shows('vidvnc [1 device]> grant');
  assert.equal(h.terminal.column, 'vidvnc [1 device]> grant '.length);
});

test('the prompt state numbers devices in list order', () => {
  const numbers = new SessionNumbers();
  const row = (id, control = 'View only') => ({ id, control, streams: [] });
  assert.equal(promptState({ sessions: [] }, numbers), 'no devices');
  assert.equal(
    promptState({ sessions: [row('a'), row('b', 'Granted')] }, numbers),
    '2 devices · #2 has control',
  );
  assert.equal(
    promptState({ sessions: [row('b', 'Granted')] }, numbers),
    '1 device · #2 has control',
  );
});
