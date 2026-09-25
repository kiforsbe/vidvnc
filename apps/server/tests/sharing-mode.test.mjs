import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccessSettings } from '../src/access-settings.mjs';
import { applySharingMode } from '../src/sharing-mode.mjs';

async function settings(t) {
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-sharing-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return AccessSettings.open(join(directory, 'access.json'));
}

test('starting local turns a saved remote setting off', async (t) => {
  const access = await settings(t);
  await access.replace(
    { publicHostnames: ['vnc.example.com'], connectionMode: 'approved-only', remoteAccess: true },
    0,
  );
  assert.equal(await applySharingMode(access, 'local'), null);
  assert.equal(access.snapshot().remoteAccess, false);
  assert.deepEqual(access.snapshot().publicHostnames, ['vnc.example.com'], 'names are kept');
});

test('starting remote turns it on with approved-only admission', async (t) => {
  const access = await settings(t);
  await access.replace({ publicHostnames: ['vnc.example.com'] }, 0);
  assert.equal(await applySharingMode(access, 'remote'), null);
  assert.equal(access.snapshot().remoteAccess, true);
  assert.equal(access.snapshot().connectionMode, 'approved-only');
});

test('without a public name, remote start stays local and says why', async (t) => {
  const access = await settings(t);
  assert.match(await applySharingMode(access, 'remote'), /needs the name or address/);
  assert.equal(access.snapshot().remoteAccess, false);
  assert.equal(access.snapshot().connectionMode, 'session-key', 'nothing was changed');
});

test('an unchanged mode writes nothing', async (t) => {
  const access = await settings(t);
  assert.equal(await applySharingMode(access, 'local'), null);
  assert.equal(access.snapshot().revision, 0);
});
