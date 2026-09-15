import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Same rules as the host's ProfileOrderStore.
export function validProfileOrder(ids) {
  return (
    Array.isArray(ids) &&
    ids.length <= 64 &&
    new Set(ids).size === ids.length &&
    ids.every((id) => typeof id === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(id))
  );
}

// Same presentation-only preference as the native host; never changes policy.
export async function applyProfileOrder(filename, profiles) {
  if (!filename) return profiles;
  let file;
  try {
    file = await open(filename, 'r');
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384) return profiles;
    const ids = JSON.parse(buffer.toString('utf8', 0, bytesRead));
    if (!validProfileOrder(ids)) return profiles;
    const available = new Map(profiles.map((profile) => [profile.id, profile]));
    return [
      ...ids.filter((id) => available.has(id)).map((id) => available.get(id)),
      ...profiles.filter((profile) => !ids.includes(profile.id)),
    ];
  } catch {
    // Missing/corrupt cosmetic preferences must not prevent a connection.
    return profiles;
  } finally {
    await file?.close();
  }
}

export async function saveProfileOrder(filename, ids) {
  if (!validProfileOrder(ids)) throw new Error('Invalid profile ordering');
  await mkdir(dirname(filename), { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const file = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await file.writeFile(JSON.stringify(ids));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, filename);
    created = false;
  } finally {
    if (created) await unlink(temporary).catch(() => {});
  }
}
