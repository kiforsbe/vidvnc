import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cmakeVersion, downloadVerified, gstreamerInstallArgs } from '../deps.mjs';

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

test('GStreamer installs silently, for the current user, with the development files', () => {
  const sdk = path.join('C:', 'repo', '.deps', 'gstreamer');
  const args = gstreamerInstallArgs(sdk);
  for (const flag of ['/VERYSILENT', '/CURRENTUSER', '/TYPE=devel', `/DIR=${sdk}`])
    assert.ok(args.includes(flag), flag);
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
