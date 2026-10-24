import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { packageOptions, launcher } from '../windows/launcher.mjs';
import { invokeBuildTools } from '../windows/build-tools.mjs';
import { publishArtifact } from '../windows/publish.mjs';

test('incomplete publication preserves the previous artifact and metadata pair', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'vidvnc-publish-'));
  try {
    const artifact = path.join(root, 'new.zip');
    const metadata = `${artifact}.json`;
    const destination = path.join(root, 'published.zip');
    writeFileSync(destination, 'old');
    writeFileSync(`${destination}.json`, 'old metadata');
    writeFileSync(artifact, 'new');
    assert.throws(() => publishArtifact(artifact, metadata, destination));
    assert.equal(readFileSync(destination, 'utf8'), 'old');
    assert.equal(readFileSync(`${destination}.json`, 'utf8'), 'old metadata');
    writeFileSync(metadata, 'new metadata');
    publishArtifact(artifact, metadata, destination);
    assert.equal(readFileSync(destination, 'utf8'), 'new');
    assert.equal(readFileSync(`${destination}.json`, 'utf8'), 'new metadata');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a failed second promotion restores both previous publication files', {
  skip: process.platform !== 'win32',
}, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'vidvnc-rollback-'));
  const artifact = path.join(root, 'new.zip');
  const metadata = `${artifact}.json`;
  const destination = path.join(root, 'published.zip');
  writeFileSync(artifact, 'new artifact');
  writeFileSync(metadata, 'new metadata');
  writeFileSync(destination, 'old artifact');
  writeFileSync(`${destination}.json`, 'old metadata');
  const holder = spawn(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "$f = [IO.File]::Open($env:VIDVNC_LOCK_FILE, 'Open', 'Read', 'Read'); try { [Console]::WriteLine('ready'); $null = [Console]::ReadLine() } finally { $f.Dispose() }",
    ],
    { env: { ...process.env, VIDVNC_LOCK_FILE: metadata }, windowsHide: true },
  );
  try {
    const [ready] = await Promise.race([
      once(holder.stdout, 'data'),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Fixture lock timed out')), 10000);
        timer.unref();
      }),
    ]);
    assert.match(ready.toString(), /ready/);
    assert.throws(() => publishArtifact(artifact, metadata, destination));
    assert.equal(readFileSync(destination, 'utf8'), 'old artifact');
    assert.equal(readFileSync(`${destination}.json`, 'utf8'), 'old metadata');
    assert.equal(readFileSync(artifact, 'utf8'), 'new artifact');
  } finally {
    holder.stdin.end('done\n');
    if (holder.exitCode === null) await once(holder, 'exit');
    rmSync(root, { recursive: true, force: true });
  }
});

test('Windows defaults select MSI or CLI ZIP; unsigned MSIX requires an explicit flag', () => {
  assert.equal(packageOptions(['windows-server']).format, 'msi');
  assert.equal(packageOptions(['windows-cli']).format, 'zip');
  assert.equal(packageOptions(['windows-server', '--msix']).format, 'msix');
  for (const args of [
    [],
    ['windows-cli', '--msix'],
    ['windows-server', '--include-node'],
    ['windows-cli', '--include-runtime-installers'],
    ['windows-server', '--msix', '--msix'],
  ])
    assert.throws(() => packageOptions(args), /Usage/);
});

test('missing tools fail before spawning native work', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'vidvnc-no-tools-'));
  try {
    assert.throws(
      () => invokeBuildTools({ operation: 'preflight' }, { root }),
      /git submodule update --init --recursive/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('shared metadata measures final unsigned bytes; native failures stop the adapter', {
  skip: process.platform !== 'win32',
}, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'VidVNC metadata Å '));
  try {
    const artifact = path.join(root, 'test.zip');
    const output = path.join(root, 'test.zip.json');
    writeFileSync(artifact, 'final fixture bytes');
    const result = invokeBuildTools({
      operation: 'metadata',
      artifact,
      output,
      version: '1.2.3',
    });
    const record = JSON.parse(readFileSync(output));
    assert.equal(
      record.SHA256.toLowerCase(),
      createHash('sha256').update(readFileSync(artifact)).digest('hex'),
    );
    assert.equal(record.Artifact, 'test.zip');
    assert.equal(record.Signed, false);
    assert.equal(result.Manifest, output);
    assert.match(record.SourceCommit, /^[0-9a-f]{40}$/);
    assert.throws(
      () =>
        invokeBuildTools({
          operation: 'run',
          tool: path.join(process.env.SystemRoot, 'System32/cmd.exe'),
          arguments: ['/d', '/c', 'exit', '19'],
          log: path.join(root, 'failed.log'),
        }),
      /failed/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI uses its bundled Node despite PATH and forwards arguments safely', {
  skip: process.platform !== 'win32',
}, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'VidVNC Å 測試 '));
  try {
    mkdirSync(path.join(root, 'runtime/node'), { recursive: true });
    writeFileSync(
      path.join(root, 'VidVNC.Server.cmd'),
      launcher({
        version: '1.2.3',
        vc: { name: 'VC++', minimumVersion: '14.44', download: 'https://example.invalid/vc' },
      }),
    );
    const cmd = path.join(process.env.SystemRoot, 'System32/cmd.exe');
    const missing = spawnSync(cmd, ['/d', '/c', path.join(root, 'VidVNC.Server.cmd')], {
      encoding: 'utf8',
      env: { ...process.env, PATH: path.dirname(process.execPath) },
    });
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /bundled Node.js is missing/);
    // A real runtime invocation is exercised by cli-bundle-check against the built ZIP.
    assert.match(
      launcher({
        version: '1.2.3',
        vc: { name: 'VC++', minimumVersion: '14.44', download: 'https://example.invalid/vc' },
      }),
      /"%NODE%".* %\*/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
