// Pure helpers for the VidVNC MSIX: manifest filling, package version and placeholder logos.
import { crc32, deflateSync } from 'node:zlib';

const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' };

// Fills every {{key}} with an XML-escaped value; unknown or unused keys are errors.
export function fillManifest(template, values) {
  const used = new Set();
  const text = template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (typeof values[key] !== 'string' || !values[key])
      throw new Error(`MSIX manifest value ${key} is missing`);
    used.add(key);
    return values[key].replace(/[&<>"']/g, (character) => escapes[character]);
  });
  const unused = Object.keys(values).filter((key) => !used.has(key));
  if (unused.length) throw new Error(`MSIX manifest template has no ${unused.join(', ')}`);
  return text;
}

// MSIX versions are four 16-bit parts; prerelease semver has no MSIX equivalent.
export function msixVersion(version) {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
  if (!parts || parts.some((part) => part > 65535))
    throw new Error(`Version ${version} cannot be an MSIX version (major.minor.patch only)`);
  return [...parts, 0].join('.');
}

function distanceToSegment(x, y, [ax, ay], [bx, by]) {
  const t = Math.max(
    0,
    Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)),
  );
  return Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay));
}

// Placeholder until the product has real icons: a white V on blue, as an RGBA PNG.
export function placeholderLogo(size) {
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte 0, then pixels
    for (let x = 0; x < size; x++) {
      const [u, v] = [(x + 0.5) / size, (y + 0.5) / size];
      const stroke = Math.min(
        distanceToSegment(u, v, [0.27, 0.27], [0.5, 0.73]),
        distanceToSegment(u, v, [0.73, 0.27], [0.5, 0.73]),
      );
      Buffer.from(stroke < 0.07 ? [255, 255, 255, 255] : [0, 95, 184, 255]).copy(row, 1 + x * 4);
    }
    rows.push(row);
  }
  const chunk = (type, data) => {
    const bytes = Buffer.alloc(12 + data.length);
    bytes.writeUInt32BE(data.length, 0);
    bytes.write(type, 4, 'latin1');
    data.copy(bytes, 8);
    bytes.writeUInt32BE(crc32(bytes.subarray(4, 8 + data.length)), 8 + data.length);
    return bytes;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
