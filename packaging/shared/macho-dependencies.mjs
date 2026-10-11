import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

// The Mach-O counterpart of pe-dependencies.mjs: reads the libraries an arm64 image loads
// and walks them from the worker and its plugins, so a package ships exactly the libraries
// they need and nothing from outside the project's GStreamer or the system.

const FAT_MAGIC = 0xcafebabe;
const FAT_MAGIC_64 = 0xcafebabf;
const MH_MAGIC_64 = 0xfeedfacf;
const CPU_TYPE_ARM64 = 0x0100000c;
// Command ids with the LC_REQ_DYLD bit (0x80000000), as unsigned numbers.
const required = (id) => (id | 0x80000000) >>> 0;
const LC_ID_DYLIB = 0xd;
const LC_RPATH = required(0x1c);
// Every command that makes dyld load another library: plain, weak, re-exported, lazy and
// upward.
const LOAD_COMMANDS = new Set([0xc, required(0x18), required(0x1f), 0x20, required(0x23)]);
const MAX_COMMANDS = 4096;
// A library file name: never a path or a parent reference.
const LIBRARY_NAME = /^[A-Za-z0-9_+~-][A-Za-z0-9._+~-]{0,254}$/;
// The sealed system volume and the shared cache. /usr/local is not part of it.
const SYSTEM = /^\/(usr\/lib|System\/Library)\//;

/**
 * The arm64 image in `bytes` (thin, or one slice of a universal file): its file type, its
 * own install name, the libraries it loads in load-command order, and its rpaths.
 */
export function readMachO(bytes) {
  const fail = (message) => {
    throw new Error(message);
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const check = (offset, size) => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > bytes.length)
      fail('Truncated Mach-O image');
    return offset;
  };
  const u32 = (offset, little = true) => view.getUint32(check(offset, 4), little);
  const u64 = (offset) => Number(view.getBigUint64(check(offset, 8), false));

  let base = 0;
  const magic = u32(0, false);
  if (magic === FAT_MAGIC || magic === FAT_MAGIC_64) {
    // A universal file: big-endian header, then one record per slice.
    const wide = magic === FAT_MAGIC_64;
    const count = u32(4, false);
    if (count > 64) fail('Universal file has too many slices');
    const size = wide ? 32 : 20;
    const slices = Array.from({ length: count }, (_, index) => 8 + index * size);
    const arm = slices.find((record) => u32(record, false) === CPU_TYPE_ARM64);
    if (arm === undefined) fail('Universal file has no arm64 slice');
    base = wide ? u64(arm + 8) : u32(arm + 8, false);
  }
  if (u32(base) !== MH_MAGIC_64) fail('Not a 64-bit Mach-O image');
  if (u32(base + 4) !== CPU_TYPE_ARM64) fail('Mach-O image is not arm64');
  const filetype = u32(base + 12);
  const count = u32(base + 16);
  const commandsSize = u32(base + 20);
  if (count > MAX_COMMANDS) fail('Mach-O image has too many load commands');
  const start = base + 32;
  const end = check(start, commandsSize) + commandsSize;
  const text = (command, size, at) => {
    const offset = u32(command + at);
    if (offset < at + 4 || offset >= size) fail('Load command string is outside its command');
    const from = command + offset;
    const stop = bytes.indexOf(0, from);
    if (stop < 0 || stop >= command + size) fail('Load command string is not terminated');
    return Buffer.from(bytes.subarray(from, stop)).toString('utf8');
  };

  const result = { filetype, id: null, libraries: [], rpaths: [] };
  let command = start;
  for (let index = 0; index < count; index++) {
    const cmd = u32(command);
    const size = u32(command + 4);
    if (size < 8 || size % 8 || command + size > end) fail('Malformed load command');
    if (cmd === LC_ID_DYLIB) result.id = text(command, size, 8);
    else if (LOAD_COMMANDS.has(cmd)) result.libraries.push(text(command, size, 8));
    else if (cmd === LC_RPATH) result.rpaths.push(text(command, size, 8));
    command += size;
  }
  return result;
}

function machOOf(file) {
  try {
    return readMachO(readFileSync(file));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
}

function indexDirectory(directory) {
  const index = new Map();
  for (const entry of readdirSync(directory, { withFileTypes: true }))
    if (entry.isFile() && entry.name.endsWith('.dylib'))
      index.set(entry.name, path.join(directory, entry.name));
  return index;
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * Walks the libraries `roots` load. A reference by `@rpath`, `@loader_path` or
 * `@executable_path` is looked up by file name in the project's approved `directories`
 * and bundled; one in the system (`/usr/lib`, `/System/Library`) is left to macOS. Anything
 * else, such as a Homebrew or `/usr/local` library, a missing or ambiguous library, or an
 * image without arm64, throws. Every bundled library is later loaded as `@rpath/<name>`.
 */
export function resolveDependencies({ roots, directories }) {
  const approved = directories.map(indexDirectory);
  const rootPaths = new Set(roots.map((root) => path.resolve(root)));
  const bundled = new Map();
  const system = new Set();
  const queue = roots.map((root) => path.resolve(root));
  for (let file = queue.shift(); file; file = queue.shift()) {
    const { id, libraries } = machOOf(file);
    for (const library of new Set(libraries)) {
      if (library === id) continue;
      if (SYSTEM.test(library)) {
        system.add(library);
        continue;
      }
      const relative = /^@(rpath|loader_path|executable_path)\//.test(library);
      const name = path.posix.basename(library);
      if (!relative || !LIBRARY_NAME.test(name))
        throw new Error(
          `${file} loads ${library}, which is neither in the system nor an @rpath library`,
        );
      const known = bundled.get(name);
      if (known) {
        if (!known.neededBy.includes(file)) known.neededBy.push(file);
        continue;
      }
      const candidates = approved.map((index) => index.get(name)).filter(Boolean);
      if (!candidates.length) throw new Error(`Missing dependency ${name} needed by ${file}`);
      if (new Set(candidates.map(sha256)).size > 1)
        throw new Error(
          `Ambiguous dependency ${name}: different files in ${candidates.join(' and ')}`,
        );
      if (rootPaths.has(candidates[0])) continue;
      bundled.set(name, { name, path: candidates[0], neededBy: [file] });
      queue.push(candidates[0]);
    }
  }
  const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    files: [...bundled.values()].sort((a, b) => byName(a.name, b.name)),
    system: [...system].sort(byName),
  };
}
