import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sourceFiles } from '../format.mjs';
import { format as clangFormat } from '@wasm-fmt/clang-format';
import { formatWebSource } from '../web-format.mjs';

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
  assert.ok(native.some((file) => file.endsWith('.mm')));
  assert.ok(native.every((file) => /\.(cpp|hpp|h|c|mm)$/.test(file)));
});

test('pinned formatters format source consistently without reordering native includes', async () => {
  const config = await readFile(new URL('../../.clang-format', import.meta.url), 'utf8');
  const input = '#include <windows.h>\n#include <algorithm>\nint main(){return 0;}\n';
  const output = clangFormat(input, 'test.cpp', config);
  assert.notEqual(output, input);
  assert.ok(output.indexOf('windows.h') < output.indexOf('algorithm'));
  assert.equal(clangFormat(output, 'test.cpp', config), output);
  const web = formatWebSource('const x={a:1};', 'test.js');
  assert.equal(web, 'const x = { a: 1 };\n');
  assert.equal(formatWebSource(web, 'test.js'), web);
});

test('web formatter preserves HTML, CSS and JSON support and rejects invalid source', () => {
  for (const [file, source] of [
    ['test.html', '<main><p>Hello</p></main>'],
    ['test.css', 'body{color:red}'],
    ['test.json', '{"value":1}'],
  ]) {
    const formatted = formatWebSource(source, file);
    assert.notEqual(formatted, source);
    assert.equal(formatWebSource(formatted, file), formatted);
  }
  assert.throws(() => formatWebSource('const = ;', 'test.js'), /Biome failed/);
});
