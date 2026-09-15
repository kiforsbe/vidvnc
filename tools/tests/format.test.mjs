import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sourceFiles } from '../format.mjs';
import { format as clangFormat } from '@wasm-fmt/clang-format';
import { format as prettierFormat } from 'prettier';

test('formatting scope excludes native host and generated/dependency directories', async () => {
  const files = await sourceFiles(fileURLToPath(new URL('../..', import.meta.url)), 'web');
  assert.ok(files.some((file) => file.endsWith('app.js')));
  assert.ok(files.some((file) => file.endsWith('main.mjs')));
  assert.ok(
    files.every(
      (file) =>
        !/[\\/](windows-host|out|node_modules|\.deps|build|diagnostics|bin|obj)[\\/]/.test(file),
    ),
  );
  const native = await sourceFiles(
    fileURLToPath(new URL('../../native', import.meta.url)),
    'native',
  );
  assert.ok(native.some((file) => file.endsWith('media-worker.cpp')));
  assert.ok(native.every((file) => /\.(cpp|hpp|h|c)$/.test(file)));
});

test('pinned formatters format source consistently without reordering native includes', async () => {
  const config = await readFile(new URL('../../.clang-format', import.meta.url), 'utf8');
  const input = '#include <windows.h>\n#include <algorithm>\nint main(){return 0;}\n';
  const output = clangFormat(input, 'test.cpp', config);
  assert.notEqual(output, input);
  assert.ok(output.indexOf('windows.h') < output.indexOf('algorithm'));
  assert.equal(clangFormat(output, 'test.cpp', config), output);
  const prettierConfig = JSON.parse(
    await readFile(new URL('../../.prettierrc.json', import.meta.url), 'utf8'),
  );
  const web = await prettierFormat('const x={a:1};', { ...prettierConfig, filepath: 'test.js' });
  assert.equal(web, 'const x = { a: 1 };\n');
  assert.equal(await prettierFormat(web, { ...prettierConfig, filepath: 'test.js' }), web);
});
