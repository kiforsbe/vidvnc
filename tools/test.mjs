import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { excluded } from './format.mjs';
import { ensureJsDependencies, ensureNativeWorker } from './dependencies.mjs';

// Test files may live in subdirectories (e.g. apps/server/tests/tls/), so discovery
// walks each configured directory recursively rather than listing it flat. Reuses
// format.mjs's `excluded` set (node_modules, build/output dirs, etc.) so a scoped
// build artifact or dependency directory dropped under a test root is pruned the
// same way source discovery already prunes it, instead of relying solely on the
// `.test.mjs` suffix to filter it back out after descending into it.
export async function testFiles(directoryUrl) {
  const found = [];
  for (const entry of await readdir(directoryUrl, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (excluded.has(entry.name)) continue;
      found.push(...(await testFiles(new URL(`${entry.name}/`, directoryUrl))));
    } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      found.push({ name: entry.name, url: new URL(entry.name, directoryUrl) });
    }
  }
  return found;
}

export async function discoverTests(mode) {
  if (!['portable', 'server', 'hardware'].includes(mode)) throw new Error('Unknown test suite');
  if (mode === 'hardware' && process.platform !== 'win32')
    throw new Error('Hardware suite requires Windows 11 25H2 and NVIDIA');
  const directories =
    mode === 'hardware'
      ? ['apps/server/tests', 'native/media-worker/tests', 'tests/system']
      : mode === 'server'
        ? ['apps/server/tests']
        : [
            'apps/server/tests',
            'apps/web-client/tests',
            'native/media-worker/tests',
            'packaging/tests',
            'tools/tests',
          ];
  const files = [];
  for (const directory of directories) {
    for (const { name, url } of await testFiles(new URL(`../${directory}/`, import.meta.url))) {
      if (mode !== 'hardware' && name === 'native-media.test.mjs') continue;
      if (mode !== 'hardware' && name === 'native-worker.test.mjs') continue;
      if (mode === 'hardware' && name === 'runtime-manifest.test.mjs') continue;
      if (
        mode === 'hardware' &&
        directory === 'apps/server/tests' &&
        name !== 'native-media.test.mjs'
      )
        continue;
      files.push(fileURLToPath(url));
    }
  }
  return files.sort();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const mode = process.argv[2] || 'portable';
  // Every suite runs against up-to-date npm packages; the hardware suite also against a worker
  // built from the current native/ sources (tools/dependencies.mjs).
  ensureJsDependencies();
  if (mode === 'hardware') ensureNativeWorker();
  const files = await discoverTests(mode);
  const child = spawn(process.execPath, ['--test', ...files], {
    stdio: 'inherit',
    windowsHide: true,
  });
  child.on('error', (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  child.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
