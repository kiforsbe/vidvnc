import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dataDirectory, settingsFiles } from '../src/paths.mjs';
import { isAlive, registerInstance, runningInstances } from '../src/instances.mjs';

test('settings live in the per-user VidVNC data folder', () => {
  assert.equal(
    dataDirectory({
      env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' },
      platform: 'win32',
      home: 'C:\\Users\\u',
    }),
    join('C:\\Users\\u\\AppData\\Local', 'VidVNC'),
  );
  assert.equal(
    dataDirectory({ env: {}, platform: 'win32', home: 'C:\\Users\\u' }),
    join('C:\\Users\\u', 'AppData', 'Local', 'VidVNC'),
  );
  assert.equal(
    dataDirectory({ env: {}, platform: 'darwin', home: '/Users/u' }),
    join('/Users/u', 'Library', 'Application Support', 'VidVNC'),
  );
  assert.deepEqual(settingsFiles('D'), {
    policy: join('D', 'stream-policy.json'),
    access: join('D', 'access-settings.json'),
    approvedClients: join('D', 'approved-clients.json'),
    profileOrder: join('D', 'profile-order.json'),
    instances: join('D', 'instances'),
  });
});

test('registered instances are listed while alive and removed on release', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-instances-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const folder = join(directory, 'instances');
  assert.deepEqual(runningInstances(folder), []);
  const release = registerInstance(folder, { mode: 'cli', port: 4382, pid: 4242, now: 1000 });
  assert.deepEqual(JSON.parse(await readFile(join(folder, '4242.json'), 'utf8')), {
    pid: 4242,
    startedAt: 1000,
    mode: 'cli',
    port: 4382,
  });
  assert.deepEqual(runningInstances(folder, { alive: (pid) => pid === 4242 }), [
    { pid: 4242, file: join(folder, '4242.json'), mode: 'cli', port: 4382 },
  ]);
  assert.deepEqual(runningInstances(folder, { alive: () => false }), []);
  release();
  release();
  assert.deepEqual(await readdir(folder), []);
});

test('registerInstance removes stale instance files but keeps live ones, its own and non-matching names', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-instances-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const folder = join(directory, 'instances');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, '111.json'), '{}'); // dead: removed
  await writeFile(join(folder, '222.json'), '{}'); // live: kept
  await writeFile(join(folder, 'notes.txt'), 'x'); // not an instance file: kept
  const alive = (pid) => pid === 222 || pid === 4242;
  const release = registerInstance(folder, {
    mode: 'cli',
    port: 4382,
    pid: 4242,
    now: 1000,
    alive,
  });
  assert.deepEqual((await readdir(folder)).sort(), ['222.json', '4242.json', 'notes.txt']);
  release();
});

test('unrelated files are skipped and unreadable files still mark a live PID', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-instances-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const folder = join(directory, 'instances');
  await mkdir(folder);
  await writeFile(join(folder, 'notes.txt'), 'x');
  await writeFile(join(folder, '77.json'), '{broken');
  await writeFile(join(folder, '78.json'), 'null');
  assert.deepEqual(runningInstances(folder, { alive: () => true }), [
    { pid: 77, file: join(folder, '77.json'), mode: 'unknown', port: null },
    { pid: 78, file: join(folder, '78.json'), mode: 'unknown', port: null },
  ]);
});

test('isAlive treats EPERM as running and other failures as gone', () => {
  const failing = (code) => () => {
    throw Object.assign(new Error(code), { code });
  };
  assert.equal(
    isAlive(1, () => true),
    true,
  );
  assert.equal(isAlive(1, failing('EPERM')), true);
  assert.equal(isAlive(1, failing('ESRCH')), false);
  assert.equal(isAlive(process.pid), true);
});
