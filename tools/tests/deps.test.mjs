import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  chooseInstall,
  cmakeVersion,
  downloadVerified,
  gstreamerInstallArgs,
  parseInstalls,
  registeredGStreamer,
} from '../deps.mjs';

const bytes = Buffer.from('installer');
const item = {
  file: 'installer.exe',
  url: 'https://example.invalid/installer.exe',
  sha256: createHash('sha256').update(bytes).digest('hex'),
};

async function folder(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'vidvnc-deps-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('a download is kept only when it matches its pin, and reused after that', async (t) => {
  const directory = await folder(t);
  let fetched = 0;
  const fetch = async () => (fetched++, new Response(bytes));
  const log = () => {};
  const file = await downloadVerified(item, { directory, fetch, log });
  assert.deepEqual(await readFile(file), bytes);
  await downloadVerified(item, { directory, fetch, log });
  assert.equal(fetched, 1);

  const other = await folder(t);
  await assert.rejects(
    downloadVerified(item, { directory: other, fetch: async () => new Response('tampered'), log }),
    /SHA-256 mismatch/,
  );
  await assert.rejects(
    downloadVerified(item, {
      directory: other,
      fetch: async () => new Response('', { status: 404 }),
      log,
    }),
    /Download failed \(404\)/,
  );
  assert.deepEqual(await readdir(other), []);
});

test('GStreamer installs silently for the current user, in its own default folder', () => {
  const args = gstreamerInstallArgs('C:\\repo\\.deps\\downloads\\gstreamer-install.log');
  for (const flag of ['/VERYSILENT', '/CURRENTUSER', '/TYPE=devel'])
    assert.ok(args.includes(flag), flag);
  // One GStreamer per user: never a private copy inside a checkout.
  assert.ok(!args.some((arg) => arg.startsWith('/DIR=')));
});

test('installed GStreamer copies are read from the Installed apps list', () => {
  assert.deepEqual(parseInstalls(''), []);
  assert.deepEqual(parseInstalls('[]'), []);
  const row = { name: 'GStreamer 1.28.6 (MSVC x86_64)', version: '1.28.6', location: 'C:\\gst\\' };
  const expected = [{ ...row, location: 'C:\\gst' }];
  assert.deepEqual(parseInstalls(JSON.stringify([row])), expected);
  // Older PowerShell writes a single object without the array.
  assert.deepEqual(parseInstalls(JSON.stringify(row)), expected);
  const calls = [];
  const found = registeredGStreamer({
    execute: (...args) => (calls.push(args), { status: 0, stdout: JSON.stringify([row]) }),
  });
  assert.deepEqual(found, expected);
  assert.match(calls[0][0], /powershell\.exe$/);
  assert.throws(
    () => registeredGStreamer({ execute: () => ({ status: 1, stderr: 'denied' }) }),
    /Listing installed apps failed: denied/,
  );
});

test('the first installed copy of the pinned version is used, and the rest say why not', () => {
  const installs = [
    { name: 'old', version: '1.26.0', location: 'C:\\old' },
    { name: 'right', version: '1.28.6', location: 'C:\\right' },
  ];
  const check = (location) => (location === 'C:\\right' ? null : 'is 1.26.0');
  assert.deepEqual(chooseInstall(installs, check), {
    install: installs[1],
    others: [{ ...installs[0], problem: 'is 1.26.0' }],
  });
  assert.deepEqual(chooseInstall([installs[0]], check).install, null);
  assert.deepEqual(chooseInstall([], check), { install: null, others: [] });
});

test('the pins name a download for every dependency the command installs', () => {
  const read = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
  const { gstreamer } = read('../../packaging/windows/inputs.json');
  const { cmake } = read('../deps.json');
  for (const pin of [gstreamer.installer, cmake.archive]) {
    assert.match(pin.url, /^https:\/\//);
    assert.ok(pin.url.endsWith(`/${pin.file}`), pin.url);
    assert.match(pin.sha256, /^[0-9a-f]{64}$/);
  }
  assert.ok(cmake.archive.file.includes(cmake.version));
  assert.equal(cmakeVersion('cmake version 3.31.6\n\nCMake suite maintained'), '3.31.6');
  assert.equal(cmakeVersion('nonsense'), null);
});
