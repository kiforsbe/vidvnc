import test from 'node:test';
import assert from 'node:assert/strict';
import { Diagnostics } from '../src/diagnostics.mjs';

test('stream diagnostics distinguish the selected physical source from encoder output', () => {
  const diagnostics = new Diagnostics();
  const source = {
    id: 'b'.repeat(64),
    number: 2,
    name: 'Portrait display',
    width: 1080,
    height: 1920,
    x: -1080,
    y: 0,
    rotation: 90,
    primary: false,
    password: 'must-not-leak',
  };
  diagnostics.startStream(
    { name: 'mobile', width: 1280, height: 720, fps: 15 },
    { mode: 'off' },
    source,
  );
  source.name = 'mutated';
  const configuration = diagnostics.snapshot().configuration;
  assert.equal(configuration.display.name, 'Portrait display');
  assert.equal(configuration.display.width, 1080);
  assert.equal(configuration.display.height, 1920);
  assert.equal(configuration.display.x, -1080);
  assert.equal(configuration.profile.width, 1280);
  assert.equal(configuration.profile.height, 720);
  assert.equal(configuration.audio.enabled, false);
  assert.equal(JSON.stringify(configuration).includes('must-not-leak'), false);
  diagnostics.startStream({ name: 'desktop', fps: 30 }, { mode: 'on' }, null);
  assert.equal(diagnostics.snapshot().configuration.display, null);
});

test('diagnostics strip secrets and arbitrary payloads, limit history, and expose sample age', () => {
  let now = 1000;
  const diagnostics = new Diagnostics({ clock: () => now, limit: 2 });
  for (let i = 0; i < 3; i++)
    diagnostics.record('server', {
      captureFps: i,
      password: 'secret',
      sdp: 'private',
      encodedMbps: Infinity,
    });
  now = 4000;
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.history.length, 2);
  assert.equal(snapshot.server.captureFps, 2);
  assert.equal(snapshot.serverAgeMs, 3000);
  assert.equal(snapshot.server.encodedMbps, null);
  assert.equal(JSON.stringify(snapshot).includes('secret'), false);
  assert.equal(JSON.stringify(snapshot).includes('private'), false);
});

test('session reset replaces profile metadata and clears previous measurements', () => {
  const diagnostics = new Diagnostics();
  diagnostics.reset({ profile: { name: 'desktop', width: 2560 }, audio: { enabled: true } });
  diagnostics.record('server', { captureFps: 30 });
  diagnostics.reset({ profile: { name: 'low-bandwidth', width: 960 }, audio: { enabled: false } });
  const snapshot = diagnostics.snapshot();
  assert.equal(snapshot.configuration?.profile.name, 'low-bandwidth');
  assert.equal(snapshot.configuration.profile.width, 960);
  assert.equal(snapshot.configuration.audio.enabled, false);
  assert.equal(snapshot.server, null);
  assert.deepEqual(snapshot.history, []);
  diagnostics.reset();
  assert.equal(diagnostics.snapshot().configuration, null);
});
