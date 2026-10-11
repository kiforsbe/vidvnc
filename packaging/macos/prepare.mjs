// Explicit preparation step for the macOS packages; building never downloads anything itself.
// Downloads the pinned Node.js archive into .deps/downloads and verifies its SHA-256.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { nodejs } = JSON.parse(readFileSync(path.join(root, 'packaging/macos/inputs.json'), 'utf8'));
const downloads = path.join(root, '.deps/downloads');
const filename = path.join(downloads, nodejs.file);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

mkdirSync(downloads, { recursive: true });
if (existsSync(filename) && sha256(readFileSync(filename)) === nodejs.sha256) {
  console.log(`nodejs: ${nodejs.file} already verified`);
} else {
  const response = await fetch(nodejs.url);
  if (!response.ok)
    throw new Error(`nodejs: download failed (${response.status}) from ${nodejs.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== nodejs.sha256)
    throw new Error(
      `nodejs: SHA-256 mismatch for ${nodejs.url}: expected ${nodejs.sha256}, got ${sha256(bytes)}`,
    );
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx' });
    renameSync(temporary, filename);
  } finally {
    rmSync(temporary, { force: true });
  }
  console.log(`nodejs: downloaded and verified ${nodejs.file}`);
}
