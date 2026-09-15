import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readPeImports, resolveDependencies } from '../shared/pe-dependencies.mjs';
import { buildPe, firstNameOffset } from './fixtures/pe.mjs';

test('reads ordinary and delay-loaded imports from PE32+ and PE32 images', () => {
  const image = buildPe({
    imports: ['KERNEL32.dll', 'glib-2.0-0.dll'],
    delayImports: ['d3d11.dll'],
  });
  assert.deepEqual(readPeImports(image), {
    machine: 0x8664,
    managed: false,
    imports: ['KERNEL32.dll', 'glib-2.0-0.dll'],
    delayImports: ['d3d11.dll'],
  });
  assert.deepEqual(readPeImports(buildPe({ imports: ['a.dll'], machine: 0x14c, pe32: true })), {
    machine: 0x14c,
    managed: false,
    imports: ['a.dll'],
    delayImports: [],
  });
  assert.deepEqual(readPeImports(buildPe()).imports, []);
  assert.equal(readPeImports(buildPe({ managed: true, pe32: true, machine: 0x14c })).managed, true);
});

test('rejects malformed images instead of guessing', () => {
  const valid = buildPe({ imports: ['a.dll'] });
  const corrupt = (edit) => {
    const copy = Buffer.from(valid);
    edit(copy);
    return copy;
  };
  assert.throws(() => readPeImports(Buffer.from('not a program')), /MZ/);
  assert.throws(
    () => readPeImports(corrupt((image) => image.writeUInt32LE(0x7fff0000, 0x3c))),
    /Truncated/,
  );
  assert.throws(
    () => readPeImports(corrupt((image) => image.writeUInt32LE(0, 0x40))),
    /PE signature/,
  );
  assert.throws(
    () => readPeImports(corrupt((image) => image.writeUInt16LE(0x107, 0x58))),
    /optional header/,
  );
  // Import directory RVA pointing outside every section.
  assert.throws(
    () => readPeImports(corrupt((image) => image.writeUInt32LE(0x9000, 0xd0))),
    /outside/,
  );
  // Name bytes that are not a plain file name, including path separators.
  const offset = firstNameOffset(['a.dll']);
  assert.throws(
    () => readPeImports(corrupt((image) => image.write('..\\a.dll', offset, 'latin1'))),
    /name/,
  );
  assert.throws(() => readPeImports(corrupt((image) => image.fill(0x41, offset))), /name/);
  assert.throws(() => readPeImports(valid.subarray(0, 0x201)), /outside|Truncated/);
});

function tree(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'vidvnc pe å '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = (name) => {
    const directory = path.join(root, name);
    mkdirSync(directory, { recursive: true });
    return directory;
  };
  const write = (directory, name, contents) => {
    const file = path.join(directory, name);
    writeFileSync(file, contents);
    return file;
  };
  return { dir, write };
}

test('bundles project dependencies recursively and reports prerequisites and OS files', (t) => {
  const { dir, write } = tree(t);
  const bin = dir('sdk/bin');
  const system = dir('System32');
  write(system, 'kernel32.dll', 'os');
  write(system, 'VCRUNTIME140.dll', 'installed with the redistributable');
  const plugins = dir('plugins');
  const worker = write(
    dir('worker'),
    'media-worker.exe',
    buildPe({ imports: ['GSTREAMER-1.0-0.DLL', 'KERNEL32.dll'] }),
  );
  const plugin = write(
    plugins,
    'gstwebrtc.dll',
    buildPe({ imports: ['gstreamer-1.0-0.dll'], delayImports: ['nice-10.dll'] }),
  );
  write(
    bin,
    'gstreamer-1.0-0.dll',
    buildPe({ imports: ['glib-2.0-0.dll', 'api-ms-win-crt-runtime-l1-1-0.dll'] }),
  );
  write(bin, 'glib-2.0-0.dll', buildPe({ imports: ['gstreamer-1.0-0.dll', 'vcruntime140.dll'] }));
  write(bin, 'nice-10.dll', buildPe({ imports: ['kernel32.dll', 'MSVCP140.dll'] }));
  write(bin, 'unrelated.dll', buildPe());

  const result = resolveDependencies({
    roots: [worker, plugin],
    directories: [bin],
    systemDirectory: system,
    prerequisites: { 'vc-redist-x64': ['vcruntime140.dll', 'msvcp140.dll'] },
  });
  assert.deepEqual(
    result.files.map(({ name, path: file }) => [name, file]),
    [
      ['glib-2.0-0.dll', path.join(bin, 'glib-2.0-0.dll')],
      ['gstreamer-1.0-0.dll', path.join(bin, 'gstreamer-1.0-0.dll')],
      ['nice-10.dll', path.join(bin, 'nice-10.dll')],
    ],
  );
  assert.deepEqual(result.files.find((file) => file.name === 'nice-10.dll').neededBy, [plugin]);
  assert.deepEqual(result.prerequisites, { 'vc-redist-x64': ['msvcp140.dll', 'vcruntime140.dll'] });
  assert.deepEqual(result.system, ['api-ms-win-crt-runtime-l1-1-0.dll', 'kernel32.dll']);
});

test('fails on missing, ambiguous, foreign-architecture and undeclared runtime dependencies', (t) => {
  const { dir, write } = tree(t);
  const first = dir('first');
  const second = dir('second');
  const system = dir('System32');
  write(system, 'msvcp140.dll', 'installed with the redistributable');
  const root = (imports) => write(dir('root'), 'root.exe', buildPe({ imports }));
  const resolve = (imports) =>
    resolveDependencies({
      roots: [root(imports)],
      directories: [first, second],
      systemDirectory: system,
    });

  assert.throws(() => resolve(['absent.dll']), /Missing dependency absent\.dll.*root\.exe/);
  assert.throws(
    () => resolve(['msvcp140.dll']),
    /Visual C\+\+ runtime.*msvcp140\.dll.*prerequisite/,
  );
  // A runtime DLL is never bundled, even when a copy sits in an approved directory.
  write(first, 'vcruntime140.dll', buildPe());
  assert.throws(() => resolve(['vcruntime140.dll']), /prerequisite/);

  write(first, 'twice.dll', buildPe({ imports: [] }));
  write(second, 'TWICE.dll', buildPe({ imports: [] }));
  assert.deepEqual(
    resolve(['twice.dll']).files.map((file) => file.path),
    [path.join(first, 'twice.dll')],
  );
  write(second, 'TWICE.dll', buildPe({ delayImports: ['x.dll'] }));
  assert.throws(() => resolve(['twice.dll']), /Ambiguous dependency twice\.dll/);

  write(first, 'x86.dll', buildPe({ machine: 0x14c, pe32: true }));
  assert.throws(() => resolve(['x86.dll']), /architecture/);
  // AnyCPU .NET assemblies have PE32 headers but load into x64 processes.
  write(system, 'mscoree.dll', 'os');
  write(
    first,
    'Managed.dll',
    buildPe({ machine: 0x14c, pe32: true, managed: true, imports: ['mscoree.dll'] }),
  );
  assert.deepEqual(
    resolve(['Managed.dll']).files.map((file) => file.name),
    ['Managed.dll'],
  );
  write(first, 'broken.dll', 'MZ but nothing else');
  assert.throws(() => resolve(['broken.dll']), /broken\.dll/);
});
