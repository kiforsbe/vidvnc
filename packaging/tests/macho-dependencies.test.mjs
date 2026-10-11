import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readMachO, resolveDependencies } from '../shared/macho-dependencies.mjs';
import { buildMachO, buildUniversal } from './fixtures/macho.mjs';

test('reads install names, loaded libraries and rpaths from thin and universal images', () => {
  const image = buildMachO({
    id: '@rpath/libgstreamer-1.0.0.dylib',
    libraries: ['@rpath/libglib-2.0.0.dylib', '/usr/lib/libSystem.B.dylib'],
    weak: ['@rpath/libweak.dylib'],
    reexports: ['@rpath/libre.dylib'],
    rpaths: ['@loader_path/../lib'],
  });
  const expected = {
    filetype: 6,
    id: '@rpath/libgstreamer-1.0.0.dylib',
    libraries: [
      '@rpath/libglib-2.0.0.dylib',
      '/usr/lib/libSystem.B.dylib',
      '@rpath/libweak.dylib',
      '@rpath/libre.dylib',
    ],
    rpaths: ['@loader_path/../lib'],
  };
  assert.deepEqual(readMachO(image), expected);
  assert.deepEqual(readMachO(buildUniversal(image)), expected);
  assert.deepEqual(readMachO(buildUniversal(image, { wide: true })), expected);
  assert.deepEqual(readMachO(buildMachO({ filetype: 2 })).libraries, []);
});

test('rejects images it cannot read instead of guessing', () => {
  const valid = buildMachO({ libraries: ['@rpath/liba.dylib'] });
  assert.throws(() => readMachO(Buffer.from('not a program')), /Mach-O/);
  assert.throws(() => readMachO(buildMachO({ cpu: 0x01000007 })), /arm64/);
  assert.throws(() => readMachO(buildUniversal(valid, { includeArm: false })), /no arm64/);
  assert.throws(() => readMachO(valid.subarray(0, 40)), /Truncated/);
  const corrupt = (edit) => {
    const copy = Buffer.from(valid);
    edit(copy);
    return copy;
  };
  // A command larger than the commands area, and a string offset outside its command.
  assert.throws(() => readMachO(corrupt((image) => image.writeUInt32LE(0x1000, 36))), /Malformed/);
  assert.throws(() => readMachO(corrupt((image) => image.writeUInt32LE(0x400, 40))), /outside/);
  // A string with no terminator inside its command.
  assert.throws(() => readMachO(corrupt((image) => image.fill(0x41, 56))), /terminated/);
});

function tree(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'vidvnc macho å '));
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

test('bundles project libraries recursively and leaves system ones to macOS', (t) => {
  const { dir, write } = tree(t);
  const lib = dir('sdk/lib');
  const worker = write(
    dir('worker'),
    'media-worker',
    buildMachO({
      filetype: 2,
      libraries: ['@rpath/libgstreamer-1.0.0.dylib', '/usr/lib/libSystem.B.dylib'],
    }),
  );
  const plugin = write(
    dir('sdk/lib/gstreamer-1.0'),
    'libgstnice.dylib',
    buildUniversal(
      buildMachO({
        id: '@rpath/libgstnice.dylib',
        libraries: ['@rpath/libgstreamer-1.0.0.dylib', '@loader_path/../libnice.10.dylib'],
      }),
    ),
  );
  write(
    lib,
    'libgstreamer-1.0.0.dylib',
    buildMachO({
      id: '@rpath/libgstreamer-1.0.0.dylib',
      libraries: [
        '@rpath/libglib-2.0.0.dylib',
        '/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation',
      ],
    }),
  );
  // A cycle back to a library already found.
  write(lib, 'libglib-2.0.0.dylib', buildMachO({ libraries: ['@rpath/libgstreamer-1.0.0.dylib'] }));
  write(
    lib,
    'libnice.10.dylib',
    buildMachO({ libraries: ['@executable_path/../lib/libglib-2.0.0.dylib'] }),
  );
  write(lib, 'libunrelated.dylib', buildMachO());

  const result = resolveDependencies({ roots: [worker, plugin], directories: [lib] });
  assert.deepEqual(
    result.files.map(({ name, path: file }) => [name, file]),
    [
      ['libglib-2.0.0.dylib', path.join(lib, 'libglib-2.0.0.dylib')],
      ['libgstreamer-1.0.0.dylib', path.join(lib, 'libgstreamer-1.0.0.dylib')],
      ['libnice.10.dylib', path.join(lib, 'libnice.10.dylib')],
    ],
  );
  assert.deepEqual(result.files.find((file) => file.name === 'libnice.10.dylib').neededBy, [
    plugin,
  ]);
  assert.deepEqual(result.system, [
    '/System/Library/Frameworks/Foundation.framework/Versions/C/Foundation',
    '/usr/lib/libSystem.B.dylib',
  ]);
});

test('fails on libraries outside the project and the system, missing and ambiguous ones', (t) => {
  const { dir, write } = tree(t);
  const first = dir('first');
  const second = dir('second');
  const resolve = (libraries) =>
    resolveDependencies({
      roots: [write(dir('root'), 'root', buildMachO({ filetype: 2, libraries }))],
      directories: [first, second],
    });

  assert.throws(
    () => resolve(['@rpath/libabsent.dylib']),
    /Missing dependency libabsent\.dylib.*root/,
  );
  for (const outside of [
    '/opt/homebrew/lib/libglib-2.0.0.dylib',
    '/usr/local/lib/libssl.3.dylib',
    '/Library/Frameworks/GStreamer.framework/Versions/1.0/lib/libgstreamer-1.0.0.dylib',
    'libbare.dylib',
  ])
    assert.throws(() => resolve([outside]), /neither in the system nor an @rpath library/);

  write(first, 'libtwice.dylib', buildMachO());
  write(second, 'libtwice.dylib', buildMachO());
  assert.deepEqual(
    resolve(['@rpath/libtwice.dylib']).files.map((file) => file.path),
    [path.join(first, 'libtwice.dylib')],
  );
  write(second, 'libtwice.dylib', buildMachO({ libraries: ['/usr/lib/libc++.1.dylib'] }));
  assert.throws(() => resolve(['@rpath/libtwice.dylib']), /Ambiguous dependency libtwice\.dylib/);

  write(first, 'libintel.dylib', buildMachO({ cpu: 0x01000007 }));
  assert.throws(() => resolve(['@rpath/libintel.dylib']), /libintel\.dylib.*arm64/);
  write(first, 'libbroken.dylib', 'not a library');
  assert.throws(() => resolve(['@rpath/libbroken.dylib']), /libbroken\.dylib/);
});
