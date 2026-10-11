import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeDevelopmentManifest } from '../debug/runtime.mjs';
import { isStale } from '../debug/host-build.mjs';
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
  const platform = 'win32';
  assert.throws(
    () => writeDevelopmentManifest({ root, configuration: 'Debug', filename, platform }),
    /worker/,
  );
  mkdirSync(path.join(root, 'out/native/windows-x64/Debug'));
  writeFileSync(path.join(root, 'out/native/windows-x64/Debug/media-worker.exe'), 'fixture');
  writeDevelopmentManifest({ root, configuration: 'Debug', filename, platform });
  const manifest = loadRuntimeManifest(filename);
  assert.equal(manifest.mode, 'development');
  assert.equal(manifest.configuration, 'Debug');
  assert.ok(manifest.worker.includes(`${path.sep}Debug${path.sep}`));
  assert.equal(manifest.node, process.execPath);
  assert.equal(manifest.os, 'windows');
  assert.throws(
    () => writeDevelopmentManifest({ root, configuration: 'Other', filename, platform }),
    /configuration/,
  );
});

test('macOS preparation writes an arm64 macOS manifest for the Debug worker', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'vidvnc mac debug '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sdk = path.join(root, 'GStreamer.framework/Versions/1.0');
  for (const name of [
    'apps/server/src',
    'out/native/macos-arm64/Debug',
    'GStreamer.framework/Versions/1.0/bin',
    'GStreamer.framework/Versions/1.0/lib/gstreamer-1.0',
  ])
    mkdirSync(path.join(root, name), { recursive: true });
  for (const name of ['apps/server/src/main.mjs', 'out/native/macos-arm64/Debug/media-worker'])
    writeFileSync(path.join(root, name), 'fixture');
  const filename = path.join(root, 'out/macos-host/Debug/runtime.json');
  writeDevelopmentManifest({ root, configuration: 'Debug', filename, sdk, platform: 'darwin' });
  const manifest = loadRuntimeManifest(filename);
  assert.equal(manifest.os, 'macos');
  assert.equal(manifest.architecture, 'arm64');
  assert.ok(manifest.worker.endsWith(path.join('macos-arm64', 'Debug', 'media-worker')));
});

test('worker staleness follows source and output timestamps and ignores tests', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'vidvnc stale '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'native/media-worker/src'), { recursive: true });
  mkdirSync(path.join(root, 'native/media-worker/tests'), { recursive: true });
  const source = path.join(root, 'native/media-worker/src/media-worker.cpp');
  const test = path.join(root, 'native/media-worker/tests/rate-control.cpp');
  const output = path.join(root, 'media-worker.exe');
  const inputs = [path.join(root, 'native')];
  const at = (file, seconds) => utimesSync(file, seconds, seconds);
  writeFileSync(source, 'source');
  writeFileSync(test, 'test');
  assert.equal(isStale(inputs, output, ['tests']), true);
  writeFileSync(output, 'built');
  at(source, 100);
  at(test, 300);
  at(output, 200);
  assert.equal(isStale(inputs, output, ['tests']), false);
  assert.equal(isStale(inputs, output), true);
  at(source, 400);
  assert.equal(isStale(inputs, output, ['tests']), true);
});
