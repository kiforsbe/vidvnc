import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Each connected device may run two video encoders; eight devices already exceed the host stream budget.
export const MAX_SESSIONS_LIMIT = 8;
const DEFAULTS = Object.freeze({
  revision: 0,
  defaultControl: 'approval',
  connectionMode: 'session-key',
  maxSessions: 4,
});

function validate(value) {
  const next = { ...DEFAULTS, ...value };
  if (
    !value ||
    !Number.isSafeInteger(next.revision) ||
    next.revision < 0 ||
    next.revision >= Number.MAX_SAFE_INTEGER ||
    !['approval', 'available'].includes(next.defaultControl) ||
    !['session-key', 'one-time-keys', 'approved-only'].includes(next.connectionMode) ||
    !Number.isSafeInteger(next.maxSessions) ||
    next.maxSessions < 1 ||
    next.maxSessions > MAX_SESSIONS_LIMIT ||
    Object.keys(value).some((key) => !Object.hasOwn(DEFAULTS, key))
  )
    throw new Error('Invalid access settings');
  return next;
}
async function read(filename) {
  try {
    return validate(JSON.parse(await readFile(filename, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return { ...DEFAULTS };
    throw error;
  }
}

// Separate from stream policy: saving admission defaults must not restart streams.
export class AccessSettings {
  #value;
  #filename;
  #queue = Promise.resolve();
  constructor(filename, value) {
    this.#filename = filename;
    this.#value = value;
  }
  static async open(filename) {
    return new AccessSettings(filename, await read(filename));
  }
  snapshot() {
    return { ...this.#value };
  }
  // Changes are merged over the current settings, so callers send only the fields they edit.
  replace(changes, revision) {
    const operation = this.#queue.then(async () => {
      const next = validate({ ...this.#value, ...changes, revision });
      if (revision !== this.#value.revision)
        throw new Error('Access settings changed; reload before saving');
      await mkdir(dirname(this.#filename), { recursive: true });
      const lockname = `${this.#filename}.lock`;
      const lock = await open(lockname, 'wx', 0o600);
      const temporary = `${this.#filename}.${randomUUID()}.tmp`;
      let created = false;
      try {
        if (JSON.stringify(await read(this.#filename)) !== JSON.stringify(this.#value))
          throw new Error('Access settings changed on disk; restart before saving');
        next.revision++;
        validate(next);
        const file = await open(temporary, 'wx', 0o600);
        created = true;
        try {
          await file.writeFile(JSON.stringify(next));
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, this.#filename);
        created = false;
        this.#value = next;
        return this.snapshot();
      } finally {
        try {
          if (created) await unlink(temporary);
        } finally {
          await lock.close();
          await unlink(lockname);
        }
      }
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
}
