import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { outputLocations, replaceDirectory, siblingDirectory } from '../shared/staging.mjs';

function workspace(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'vidvnc staging å '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('output locations stay under out/ and are created as plain directories', (t) => {
  const root = workspace(t);
  const locations = outputLocations(root, {
    target: 'windows-cli',
    configuration: 'Release',
    version: '0.1.0',
  });
  assert.deepEqual(locations, {
    stage: path.join(root, 'out/packages/windows-cli/Release'),
    installers: path.join(root, 'out/installers/windows-cli/0.1.0'),
  });
  assert.ok(existsSync(locations.installers));
  assert.ok(existsSync(path.dirname(locations.stage)));
  assert.equal(
    existsSync(locations.stage),
    false,
    'the stage itself is only swapped in when complete',
  );
});

test('rejects unsafe target, configuration and version names', (t) => {
  const root = workspace(t);
  const valid = { target: 'windows-cli', configuration: 'Release', version: '0.1.0' };
  for (const change of [
    { target: '../windows-cli' },
    { target: 'Windows CLI' },
    { configuration: 'release' },
    { configuration: '..' },
    { version: '1.0' },
    { version: '0.1.0/../../x' },
  ])
    assert.throws(() => outputLocations(root, { ...valid, ...change }), /Invalid/);
  assert.equal(existsSync(path.join(root, 'out')), false);
});

test('refuses output paths that are links, junctions or files', (t) => {
  const root = workspace(t);
  const outside = path.join(root, 'outside');
  mkdirSync(path.join(outside, 'windows-cli'), { recursive: true });
  writeFileSync(path.join(outside, 'windows-cli/keep.txt'), 'keep');
  mkdirSync(path.join(root, 'repo/out'), { recursive: true });
  symlinkSync(outside, path.join(root, 'repo/out/packages'), 'junction');
  const options = { target: 'windows-cli', configuration: 'Release', version: '0.1.0' };
  assert.throws(() => outputLocations(path.join(root, 'repo'), options), /not a plain directory/);

  rmSync(path.join(root, 'repo/out/packages'));
  mkdirSync(path.join(root, 'repo/out/installers'), { recursive: true });
  writeFileSync(path.join(root, 'repo/out/installers/windows-cli'), 'file');
  assert.throws(() => outputLocations(path.join(root, 'repo'), options), /not a plain directory/);
  assert.equal(readFileSync(path.join(outside, 'windows-cli/keep.txt'), 'utf8'), 'keep');
});

test('swaps a built tree into place and removes only the previous tree', (t) => {
  const root = workspace(t);
  const destination = path.join(root, 'Release');
  mkdirSync(destination);
  writeFileSync(path.join(destination, 'old.txt'), 'old');
  const built = siblingDirectory(destination);
  writeFileSync(path.join(built, 'new.txt'), 'new');
  replaceDirectory(built, destination);
  assert.deepEqual(readdirSync(destination), ['new.txt']);
  assert.deepEqual(readdirSync(root), ['Release']);

  const elsewhere = path.join(root, 'nested/built');
  mkdirSync(elsewhere, { recursive: true });
  assert.throws(() => replaceDirectory(elsewhere, destination), /sibling/);
  assert.deepEqual(readdirSync(destination), ['new.txt']);
});

// Antivirus and indexers briefly lock freshly written trees on Windows.
const locked = (syscall) => Object.assign(new Error(`EPERM: ${syscall}`), { code: 'EPERM' });

test('retries a swap that a short-lived lock refuses', (t) => {
  const root = workspace(t);
  const destination = path.join(root, 'Release');
  mkdirSync(destination);
  writeFileSync(path.join(destination, 'old.txt'), 'old');
  const built = siblingDirectory(destination);
  writeFileSync(path.join(built, 'new.txt'), 'new');
  let refusals = 2;
  const rename = (from, to) => {
    if (from === built && refusals-- > 0) throw locked('rename');
    renameSync(from, to);
  };
  replaceDirectory(built, destination, { rename, pause: () => {} });
  assert.deepEqual(readdirSync(destination), ['new.txt']);
  assert.deepEqual(readdirSync(root), ['Release']);
});

test('restores the previous tree when the built tree cannot be swapped in', (t) => {
  const root = workspace(t);
  const destination = path.join(root, 'Release');
  mkdirSync(destination);
  writeFileSync(path.join(destination, 'old.txt'), 'old');
  const built = siblingDirectory(destination);
  writeFileSync(path.join(built, 'new.txt'), 'new');
  const rename = (from, to) => {
    if (from === built) throw locked('rename');
    renameSync(from, to);
  };
  assert.throws(() => replaceDirectory(built, destination, { rename, pause: () => {} }), /EPERM/);
  assert.deepEqual(readdirSync(destination), ['old.txt']);
  assert.deepEqual(readdirSync(root).sort(), [path.basename(built), 'Release'].sort());
});
