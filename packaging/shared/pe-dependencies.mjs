import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const IMPORT_DIRECTORY = 1;
const DELAY_IMPORT_DIRECTORY = 13;
const CLR_RUNTIME_HEADER = 14;
const MAX_DESCRIPTORS = 4096;
// A DLL name is a bare file name: never a path, drive or parent reference.
const DLL_NAME = /^[A-Za-z0-9_+~-][A-Za-z0-9._+~-]{0,254}$/;
// Windows API-set contracts resolve inside the loader, never to files.
const API_SET = /^(api|ext)-ms-/i;
// Present in System32 on machines with the redistributable installed, but not part of Windows.
const VC_RUNTIME = /^(vcruntime|msvcp|concrt|vccorlib|vcomp|mfc|vcamp)\d/i;

// Returns the DLL names a PE image imports directly and through delay loading, and whether
// it is a .NET assembly.
export function readPeImports(bytes) {
  const fail = (message) => {
    throw new Error(message);
  };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const check = (offset, size) => {
    if (!Number.isInteger(offset) || offset < 0 || offset + size > bytes.length)
      fail('Truncated PE image');
    return offset;
  };
  const u16 = (offset) => view.getUint16(check(offset, 2), true);
  const u32 = (offset) => view.getUint32(check(offset, 4), true);

  if (bytes.length < 2 || u16(0) !== 0x5a4d) fail('Missing MZ header');
  const pe = u32(0x3c);
  if (u32(pe) !== 0x4550) fail('Missing PE signature');
  const machine = u16(pe + 4);
  const sectionCount = u16(pe + 6);
  const optionalSize = u16(pe + 20);
  const optional = pe + 24;
  const magic = u16(optional);
  if (magic !== 0x20b && magic !== 0x10b) fail('Unsupported PE optional header');
  const pe32Plus = magic === 0x20b;
  const directories = optional + (pe32Plus ? 112 : 96);
  const directoryCount = u32(directories - 4);
  const directory = (index) => {
    if (index >= directoryCount || directories + (index + 1) * 8 > optional + optionalSize)
      return { rva: 0, size: 0 };
    return { rva: u32(directories + index * 8), size: u32(directories + index * 8 + 4) };
  };

  const sections = [];
  for (let index = 0; index < sectionCount; index++) {
    const header = optional + optionalSize + index * 40;
    sections.push({
      virtualSize: u32(header + 8),
      virtualAddress: u32(header + 12),
      rawSize: u32(header + 16),
      rawPointer: u32(header + 20),
    });
  }
  const fileOffset = (rva) => {
    for (const section of sections) {
      const relative = rva - section.virtualAddress;
      if (relative >= 0 && relative < section.rawSize) return section.rawPointer + relative;
    }
    return fail(`Import table RVA 0x${rva.toString(16)} is outside every section`);
  };
  const readName = (rva) => {
    const start = check(fileOffset(rva), 1);
    const end = bytes.indexOf(0, start);
    const name = end < 0 ? null : Buffer.from(bytes.subarray(start, end)).toString('latin1');
    if (name === null || !DLL_NAME.test(name) || name.includes('..'))
      fail(`Invalid imported DLL name at RVA 0x${rva.toString(16)}`);
    return name;
  };
  const table = (index, size, nameAt, stop) => {
    const { rva } = directory(index);
    const names = [];
    if (!rva) return names;
    const start = fileOffset(rva);
    for (let entry = 0; ; entry++) {
      if (entry >= MAX_DESCRIPTORS) fail('Import table has no terminator');
      const offset = check(start + entry * size, size);
      if (stop(offset)) return names;
      names.push(readName(nameAt(offset)));
    }
  };

  const imports = table(
    IMPORT_DIRECTORY,
    20,
    (offset) => u32(offset + 12),
    (offset) => u32(offset + 12) === 0 && u32(offset + 16) === 0,
  );
  const delayImports = table(
    DELAY_IMPORT_DIRECTORY,
    32,
    (offset) => {
      // Pre-RVA delay-load descriptors store virtual addresses; no supported toolchain emits them.
      if ((u32(offset) & 1) === 0) fail('Unsupported delay-import descriptor');
      return u32(offset + 4);
    },
    (offset) => u32(offset + 4) === 0,
  );
  return { machine, managed: directory(CLR_RUNTIME_HEADER).rva !== 0, imports, delayImports };
}

// Index a directory by lower-case file name so lookups match the Windows loader.
function indexDirectory(directory) {
  const entries = new Map();
  for (const entry of readdirSync(directory, { withFileTypes: true }))
    if (entry.isFile()) entries.set(entry.name.toLowerCase(), path.join(directory, entry.name));
  return entries;
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function importsOf(file) {
  try {
    return readPeImports(readFileSync(file));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
}

/**
 * Walks the import graph of `roots`. DLLs listed under a declared prerequisite
 * (`{ id: [dll names] }`) are reported, never bundled. Other dependencies found in the
 * project's approved `directories` are bundled; API sets and files present in
 * `systemDirectory` are left to Windows. Undeclared Visual C++ runtime DLLs, missing,
 * ambiguous and foreign-architecture native dependencies throw.
 */
export function resolveDependencies({ roots, directories, systemDirectory, prerequisites = {} }) {
  const approved = directories.map(indexDirectory);
  const system = new Set(indexDirectory(systemDirectory).keys());
  const declared = new Map(
    Object.entries(prerequisites).flatMap(([id, names]) =>
      names.map((name) => [name.toLowerCase(), id]),
    ),
  );
  const rootPaths = new Set(roots.map((root) => path.resolve(root).toLowerCase()));
  const bundled = new Map();
  const required = new Map();
  const provided = new Set();
  const queue = roots.map((root) => path.resolve(root));
  let expected;
  for (let file = queue.shift(); file; file = queue.shift()) {
    const { machine, managed, imports, delayImports } = importsOf(file);
    // AnyCPU .NET assemblies carry a PE32 header whichever process loads them.
    if (!managed) expected ??= machine;
    if (!managed && machine !== expected)
      throw new Error(`${file} has a different architecture (machine 0x${machine.toString(16)})`);
    for (const imported of new Set(
      [...imports, ...delayImports].map((name) => name.toLowerCase()),
    )) {
      const known = bundled.get(imported);
      if (known) {
        if (!known.neededBy.includes(file)) known.neededBy.push(file);
        continue;
      }
      if (API_SET.test(imported)) {
        provided.add(imported);
        continue;
      }
      if (declared.has(imported)) {
        const id = declared.get(imported);
        required.set(id, (required.get(id) ?? new Set()).add(imported));
        continue;
      }
      if (VC_RUNTIME.test(imported))
        throw new Error(
          `Visual C++ runtime DLL ${imported} (needed by ${file}) must be declared as a prerequisite`,
        );
      const candidates = approved.map((index) => index.get(imported)).filter(Boolean);
      if (candidates.length) {
        const distinct = new Set(candidates.map(sha256));
        if (distinct.size > 1)
          throw new Error(
            `Ambiguous dependency ${imported}: different files in ${candidates.join(' and ')}`,
          );
        const source = candidates[0];
        if (rootPaths.has(source.toLowerCase())) continue;
        bundled.set(imported, { name: path.basename(source), path: source, neededBy: [file] });
        queue.push(source);
        continue;
      }
      if (system.has(imported)) {
        provided.add(imported);
        continue;
      }
      throw new Error(`Missing dependency ${imported} needed by ${file}`);
    }
  }
  const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return {
    files: [...bundled.values()].sort((a, b) => byName(a.name.toLowerCase(), b.name.toLowerCase())),
    prerequisites: Object.fromEntries(
      [...required]
        .sort(([a], [b]) => byName(a, b))
        .map(([id, names]) => [id, [...names].sort(byName)]),
    ),
    system: [...provided].sort(byName),
  };
}
