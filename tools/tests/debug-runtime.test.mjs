import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeDevelopmentManifest } from '../debug/runtime.mjs';
import { loadRuntimeManifest } from '../../native/media-worker/runtime-manifest.mjs';

test('Debug preparation requires Debug output and writes a validated explicit manifest', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'vidvnc debug å '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of [
    'apps/server/src',
    'out/native/windows-x64/Release',
    '.deps/gstreamer/bin',
    '.deps/gstreamer/lib/gstreamer-1.0',
    'host',
  ])
    mkdirSync(path.join(root, name), { recursive: true });
  for (const name of [
    'apps/server/src/main.mjs',
    'out/native/windows-x64/Release/media-worker.exe',
  ])
    writeFileSync(path.join(root, name), 'fixture');
  const filename = path.join(root, 'host/runtime.json');
  assert.throws(
    () => writeDevelopmentManifest({ root, configuration: 'Debug', filename }),
    /worker/,
  );
  mkdirSync(path.join(root, 'out/native/windows-x64/Debug'));
  writeFileSync(path.join(root, 'out/native/windows-x64/Debug/media-worker.exe'), 'fixture');
  writeDevelopmentManifest({ root, configuration: 'Debug', filename });
  const manifest = loadRuntimeManifest(filename);
  assert.equal(manifest.mode, 'development');
  assert.equal(manifest.configuration, 'Debug');
  assert.ok(manifest.worker.includes(`${path.sep}Debug${path.sep}`));
  assert.equal(manifest.node, process.execPath);
  assert.throws(
    () => writeDevelopmentManifest({ root, configuration: 'Other', filename }),
    /configuration/,
  );
});
