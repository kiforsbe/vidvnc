// Builds a minimal PE image whose single section holds its import tables.
export function buildPe({
  imports = [],
  delayImports = [],
  machine = 0x8664,
  pe32 = false,
  managed = false,
} = {}) {
  const headerSize = 0x200;
  const sectionRva = 0x1000;
  const peOffset = 0x40;
  const importTableSize = imports.length ? 20 * (imports.length + 1) : 0;
  const delayTableSize = delayImports.length ? 32 * (delayImports.length + 1) : 0;
  const names = [...imports, ...delayImports];
  const nameOffsets = [];
  let cursor = importTableSize + delayTableSize;
  for (const name of names) {
    nameOffsets.push(cursor);
    cursor += Buffer.byteLength(name, 'latin1') + 1;
  }
  const rawSize = Math.max(0x200, Math.ceil(cursor / 0x200) * 0x200);
  const image = Buffer.alloc(headerSize + rawSize);
  image.writeUInt16LE(0x5a4d, 0);
  image.writeUInt32LE(peOffset, 0x3c);
  image.writeUInt32LE(0x4550, peOffset);
  const coff = peOffset + 4;
  const optionalSize = pe32 ? 224 : 240;
  image.writeUInt16LE(machine, coff);
  image.writeUInt16LE(1, coff + 2);
  image.writeUInt16LE(optionalSize, coff + 16);
  const optional = coff + 20;
  image.writeUInt16LE(pe32 ? 0x10b : 0x20b, optional);
  const directories = optional + (pe32 ? 96 : 112);
  image.writeUInt32LE(16, directories - 4);
  if (imports.length) {
    image.writeUInt32LE(sectionRva, directories + 8);
    image.writeUInt32LE(importTableSize, directories + 12);
  }
  if (delayImports.length) {
    image.writeUInt32LE(sectionRva + importTableSize, directories + 13 * 8);
    image.writeUInt32LE(delayTableSize, directories + 13 * 8 + 4);
  }
  // A CLR runtime header marks a .NET assembly; only its presence matters here.
  if (managed) {
    image.writeUInt32LE(sectionRva, directories + 14 * 8);
    image.writeUInt32LE(72, directories + 14 * 8 + 4);
  }
  const section = optional + optionalSize;
  image.write('.idata', section, 'latin1');
  image.writeUInt32LE(rawSize, section + 8);
  image.writeUInt32LE(sectionRva, section + 12);
  image.writeUInt32LE(rawSize, section + 16);
  image.writeUInt32LE(headerSize, section + 20);
  imports.forEach((_, index) => {
    const descriptor = headerSize + index * 20;
    image.writeUInt32LE(sectionRva + nameOffsets[index], descriptor + 12);
    image.writeUInt32LE(sectionRva, descriptor + 16);
  });
  delayImports.forEach((_, index) => {
    const descriptor = headerSize + importTableSize + index * 32;
    image.writeUInt32LE(1, descriptor);
    image.writeUInt32LE(sectionRva + nameOffsets[imports.length + index], descriptor + 4);
  });
  // Buffer.alloc zero-fills, so every name is already terminated.
  names.forEach((name, index) => image.write(name, headerSize + nameOffsets[index], 'latin1'));
  return image;
}

// File offset of the first import name, for corrupting fixtures.
export const firstNameOffset = (imports, delayImports = []) =>
  0x200 +
  (imports.length ? 20 * (imports.length + 1) : 0) +
  (delayImports.length ? 32 * (delayImports.length + 1) : 0);
