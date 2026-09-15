import { open, mkdir, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultStreamPolicy, validateStreamPolicy } from './stream-policy.mjs';

async function readPolicy(filename) {
  let file;
  try {
    file = await open(filename, 'r');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 65536) throw new Error('Stream policy exceeds 64 KiB');
    return validateStreamPolicy(JSON.parse(buffer.subarray(0, length).toString('utf8')));
  } finally {
    await file.close();
  }
}

export class StreamPolicyStore {
  #filename;
  #value;
  #queue = Promise.resolve();
  #persisted;
  static async open(filename) {
    const path = resolve(filename);
    const value = await readPolicy(path);
    return new StreamPolicyStore(path, value ?? defaultStreamPolicy(), value !== null);
  }
  constructor(filename, value, persisted) {
    this.#filename = filename;
    this.#value = validateStreamPolicy(value);
    this.#persisted = persisted;
  }
  snapshot() {
    return structuredClone(this.#value);
  }
  replace(candidate, expectedRevision) {
    // Capture edits at submission, not after another queued write finishes.
    let next;
    try {
      next = validateStreamPolicy(candidate);
    } catch (error) {
      return Promise.reject(error);
    }
    const operation = this.#queue.then(() => this.#commit(next, expectedRevision));
    this.#queue = operation.catch(() => {});
    return operation;
  }
  async #commit(next, expectedRevision) {
    if (expectedRevision !== this.#value.revision || next.revision !== expectedRevision)
      throw new Error('Configuration changed; reload before saving (revision conflict)');
    await mkdir(dirname(this.#filename), { recursive: true });
    // Exclusive sibling lock serializes independent stores/processes too. A
    // stranded lock fails closed; never guess whether another owner is alive.
    const lockname = `${this.#filename}.lock`;
    let lock;
    try {
      lock = await open(lockname, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST')
        throw new Error('Configuration is being saved; retry after the owner completes');
      throw error;
    }
    const temporary = `${this.#filename}.${randomUUID()}.tmp`;
    let created = false;
    try {
      const disk = await readPolicy(this.#filename);
      if (
        (disk !== null) !== this.#persisted ||
        (disk && JSON.stringify(disk) !== JSON.stringify(this.#value))
      )
        throw new Error('Configuration changed on disk; reload before saving');
      next.revision = expectedRevision + 1;
      const committed = validateStreamPolicy(next);
      const file = await open(temporary, 'wx', 0o600);
      created = true;
      try {
        await file.writeFile(JSON.stringify(committed));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.#filename);
      created = false;
      this.#value = committed;
      this.#persisted = true;
      return this.snapshot();
    } finally {
      try {
        if (created) await unlink(temporary);
      } finally {
        await lock.close();
        await unlink(lockname);
      }
    }
  }
}
