// Builds a minimal arm64 Mach-O image holding only the load commands the dependency walk
// reads, optionally wrapped in a universal file next to an x86_64 slice.
const ARM64 = 0x0100000c;
const X86_64 = 0x01000007;
const COMMANDS = { id: 0xd, load: 0xc, weak: 0x80000018, reexport: 0x8000001f, rpath: 0x8000001c };

function command(cmd, text, headerSize) {
  const bytes = Buffer.from(`${text}\0`, 'utf8');
  const size = Math.ceil((headerSize + bytes.length) / 8) * 8;
  const out = Buffer.alloc(size);
  out.writeUInt32LE(cmd, 0);
  out.writeUInt32LE(size, 4);
  out.writeUInt32LE(headerSize, 8);
  bytes.copy(out, headerSize);
  return out;
}

export function buildMachO({
  id = null,
  libraries = [],
  weak = [],
  reexports = [],
  rpaths = [],
  cpu = ARM64,
  filetype = 6,
} = {}) {
  const commands = [
    ...(id ? [command(COMMANDS.id, id, 24)] : []),
    ...libraries.map((name) => command(COMMANDS.load, name, 24)),
    ...weak.map((name) => command(COMMANDS.weak, name, 24)),
    ...reexports.map((name) => command(COMMANDS.reexport, name, 24)),
    ...rpaths.map((name) => command(COMMANDS.rpath, name, 12)),
  ];
  const body = Buffer.concat(commands);
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(cpu, 4);
  header.writeUInt32LE(filetype, 12);
  header.writeUInt32LE(commands.length, 16);
  header.writeUInt32LE(body.length, 20);
  return Buffer.concat([header, body]);
}

// A universal file with an x86_64 slice first, so the reader has to pick the arm64 one.
export function buildUniversal(arm64, { wide = false, includeArm = true } = {}) {
  const intel = buildMachO({ cpu: X86_64, libraries: ['/usr/local/lib/intel-only.dylib'] });
  const slices = includeArm ? [intel, arm64] : [intel];
  const record = wide ? 32 : 20;
  const align = 0x100;
  const header = Buffer.alloc(8 + slices.length * record);
  header.writeUInt32BE(wide ? 0xcafebabf : 0xcafebabe, 0);
  header.writeUInt32BE(slices.length, 4);
  let offset = Math.ceil(header.length / align) * align;
  const parts = [header];
  let cursor = header.length;
  slices.forEach((slice, index) => {
    const at = 8 + index * record;
    header.writeUInt32BE(slice === intel ? X86_64 : ARM64, at);
    if (wide) {
      header.writeBigUInt64BE(BigInt(offset), at + 8);
      header.writeBigUInt64BE(BigInt(slice.length), at + 16);
    } else {
      header.writeUInt32BE(offset, at + 8);
      header.writeUInt32BE(slice.length, at + 12);
    }
    parts.push(Buffer.alloc(offset - cursor), slice);
    cursor = offset + slice.length;
    offset = Math.ceil(cursor / align) * align;
  });
  return Buffer.concat(parts);
}
