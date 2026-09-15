import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dataDirectory } from '../src/paths.mjs';

const main = fileURLToPath(new URL('../src/main.mjs', import.meta.url));

async function sandbox(t) {
  const home = await mkdtemp(join(tmpdir(), 'vidvnc-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = {
    ...process.env,
    LOCALAPPDATA: home,
    HOME: home,
    VIDVNC_MEDIA_WORKER: join(home, 'missing-worker.exe'),
  };
  delete env.VIDVNC_RUNTIME_MANIFEST;
  delete env.VIDVNC_LOG_DIR;
  const config = (...args) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [main, 'config', ...args], { env, windowsHide: true });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  return { data: dataDirectory({ env, home }), config };
}

test('config with no command prints help without starting a server', async (t) => {
  const { config } = await sandbox(t);
  const result = await config();
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^Commands:\n/);
  assert.match(result.stdout, /config share <display> on\|off/);
  assert.doesNotMatch(result.stdout, /^ {2}config sessions$/m);
  assert.equal(result.stderr, '');
});

test('offline edits persist between invocations and --json reads them back', async (t) => {
  const { config } = await sandbox(t);
  assert.equal((await config('access', 'available')).code, 0);
  assert.equal(JSON.parse((await config('access', '--json')).stdout).defaultControl, 'available');
  const added = await config('profile', 'add', 'Office desk', '--fps', '60');
  assert.equal(added.code, 0);
  assert.equal(added.stdout, 'Added profile "Office desk" with ID office-desk.\n');
  assert.equal((await config('profile', 'move', 'office-desk', '1')).code, 0);
  const shown = JSON.parse((await config('show', '--json')).stdout);
  assert.equal(shown.profileOrder[0], 'office-desk');
  assert.equal(shown.policy.profiles.find((profile) => profile.id === 'office-desk').fps, 60);
});

test('exit codes separate usage errors from failures', async (t) => {
  const { config } = await sandbox(t);
  assert.equal((await config('share')).code, 2);
  const live = await config('sessions');
  assert.equal(live.code, 2);
  assert.match(live.stderr, /only available in the running server console/);
  assert.equal((await config('profile', 'remove', 'nope')).code, 1);
  const displays = await config('displays');
  assert.equal(displays.code, 1);
  assert.match(displays.stderr, /^Display information is unavailable: /);
});

test('changes refuse while a registered server is alive and ignore stale records', async (t) => {
  const { data, config } = await sandbox(t);
  await mkdir(join(data, 'instances'), { recursive: true });
  const live = join(data, 'instances', `${process.pid}.json`);
  await writeFile(
    live,
    JSON.stringify({ pid: process.pid, startedAt: Date.now(), mode: 'cli', port: 4382 }),
  );
  const refused = await config('access', 'available');
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, new RegExp(`VidVNC is running \\(PID ${process.pid}, `));
  assert.equal((await config('access')).code, 0);
  await rm(live);
  const exited = spawn(process.execPath, ['-e', ''], { windowsHide: true });
  await new Promise((resolve) => exited.on('close', resolve));
  await writeFile(join(data, 'instances', `${exited.pid}.json`), '{}');
  assert.equal((await config('access', 'available')).code, 0);
});
