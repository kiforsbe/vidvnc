import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mode = process.argv[2] || 'portable';
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
// Test files may live in subdirectories (e.g. apps/server/tests/tls/), so discovery
// walks each configured directory recursively rather than listing it flat.
async function testFiles(directoryUrl) {
  const found = [];
  for (const entry of await readdir(directoryUrl, { withFileTypes: true })) {
    const entryUrl = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, directoryUrl);
    if (entry.isDirectory()) found.push(...(await testFiles(entryUrl)));
    else if (entry.isFile() && entry.name.endsWith('.test.mjs'))
      found.push({ name: entry.name, url: entryUrl });
  }
  return found;
}

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
const child = spawn(process.execPath, ['--test', ...files.sort()], {
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
