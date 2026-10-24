// Explicit hash-verified package downloads only. Never creates keys or changes trust.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const inputs = JSON.parse(readFileSync(path.join(root, 'packaging/windows/inputs.json'), 'utf8'));
const downloads = path.join(root, '.deps/downloads');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function writeAtomically(filename, bytes) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx' });
    renameSync(temporary, filename);
  } finally {
    rmSync(temporary, { force: true });
  }
}

mkdirSync(downloads, { recursive: true });
for (const [id, prerequisite] of Object.entries(inputs.prerequisites)) {
  for (const item of [prerequisite.bundle].filter((entry) => entry?.url)) {
    const filename = path.join(downloads, item.file);
    if (existsSync(filename) && sha256(readFileSync(filename)) === item.sha256) {
      console.log(`${id}: ${item.file} already verified`);
      continue;
    }
    const response = await fetch(item.url);
    if (!response.ok)
      throw new Error(`${id}: download failed (${response.status}) from ${item.url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = sha256(bytes);
    if (actual !== item.sha256)
      throw new Error(
        `${id}: SHA-256 mismatch for ${item.url}: expected ${item.sha256}, got ${actual}`,
      );
    writeAtomically(filename, bytes);
    console.log(`${id}: downloaded and verified ${item.file}`);
  }
}
