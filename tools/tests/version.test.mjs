import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION_FILES, readVersions, setVersion } from '../version.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

async function copyOfCheckout(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vidvnc-version-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of VERSION_FILES) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await copyFile(path.join(root, file), path.join(directory, file));
  }
  return directory;
}

const contents = async (directory) =>
  Object.fromEntries(
    await Promise.all(
      VERSION_FILES.map(async (file) => [file, await readFile(path.join(directory, file), 'utf8')]),
    ),
  );

test('every file in the checkout declares the same version', async () => {
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const found = await readVersions(root);
  assert.deepEqual(new Set(found.map((entry) => entry.version)), new Set([version]));
  assert.deepEqual(
    new Set(found.map((entry) => entry.file)),
    new Set(VERSION_FILES.filter((file) => file !== 'CHANGELOG.md')),
  );
  assert.ok(found.some((entry) => entry.label === 'dependencies.@vidvnc/web-client'));
});

test('setting a version changes only version values and adds a changelog section', async (t) => {
  const directory = await copyOfCheckout(t);
  const before = await contents(directory);
  const result = await setVersion('v1.2.3', directory);
  assert.equal(result.version, '1.2.3');
  assert.deepEqual(result.changed, VERSION_FILES);
  assert.ok((await readVersions(directory)).every((entry) => entry.version === '1.2.3'));

  const after = await contents(directory);
  assert.match(after['apps/windows-host/app.manifest'], /<assemblyIdentity version="1\.2\.3\.0"/);
  const changelog = after['CHANGELOG.md'];
  assert.ok(changelog.indexOf('## [1.2.3] - Unreleased') < changelog.search(/^## \[(?!1\.2\.3)/m));
  for (const file of VERSION_FILES.filter((name) => name !== 'CHANGELOG.md')) {
    const [old, updated] = [before[file].split('\n'), after[file].split('\n')];
    assert.equal(updated.length, old.length, file);
    updated.forEach((line, index) => {
      if (line !== old[index]) assert.match(line, /1\.2\.3/, `${file}:${index + 1}`);
    });
  }

  assert.deepEqual((await setVersion('1.2.3', directory)).changed, []);
});

test('an invalid version or a missing field leaves every file unchanged', async (t) => {
  const directory = await copyOfCheckout(t);
  const original = await contents(directory);
  for (const version of ['1.2', '1.2.3-beta.1', '01.2.3', '1.65536.0', ''])
    await assert.rejects(setVersion(version, directory), /version/i, version);
  assert.deepEqual(await contents(directory), original);

  const project = path.join(directory, 'apps/windows-host/VidVnc.Host.csproj');
  await writeFile(
    project,
    original['apps/windows-host/VidVnc.Host.csproj'].replace(/<Version>.*\n/, ''),
  );
  const edited = await contents(directory);
  await assert.rejects(setVersion('2.0.0', directory), /VidVnc\.Host\.csproj: Version is missing/);
  assert.deepEqual(await contents(directory), edited);
});
