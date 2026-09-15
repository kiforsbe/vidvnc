import { createHash, randomBytes } from 'node:crypto';
import { normalizePassword } from '@vidvnc/web-client/password-entry.js';

export const CONNECTION_KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CONNECTION_KEY_PURPOSES = Object.freeze({
  session: 'session',
  setup: 'approved-client-setup',
  once: 'one-time-connection',
});
const PURPOSE_CODES = new Map([
  [CONNECTION_KEY_PURPOSES.session, 0],
  [CONNECTION_KEY_PURPOSES.setup, 1],
  [CONNECTION_KEY_PURPOSES.once, 2],
]);
const CODE_PURPOSES = [
  CONNECTION_KEY_PURPOSES.session,
  CONNECTION_KEY_PURPOSES.setup,
  CONNECTION_KEY_PURPOSES.once,
  null,
];

function digest(key) {
  return createHash('sha256').update(key).digest('base64url');
}

function randomIndex(limit) {
  const accepted = Math.floor(256 / limit) * limit;
  while (true) {
    const value = randomBytes(1)[0];
    if (value < accepted) return value % limit;
  }
}

function generate(purpose) {
  const code = PURPOSE_CODES.get(purpose);
  if (code === undefined) throw new Error('Invalid connection-key purpose');
  const first = [...CONNECTION_KEY_ALPHABET].filter((_, index) => index % 4 === code);
  let raw = first[randomIndex(first.length)];
  while (raw.length < 8)
    raw += CONNECTION_KEY_ALPHABET[randomIndex(CONNECTION_KEY_ALPHABET.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function connectionKeyPurpose(value) {
  const key = normalizePassword(value);
  if (!key) return null;
  const index = CONNECTION_KEY_ALPHABET.indexOf(key[0]);
  return index < 0 ? null : CODE_PURPOSES[index % 4];
}

export class ConnectionKeyRegistry {
  #records = new Map();
  #sessionKey = null;
  constructor({ clock = () => Date.now() } = {}) {
    this.clock = clock;
    this.rotateSession();
  }
  get sessionKey() {
    return this.#sessionKey;
  }
  rotateSession() {
    if (this.#sessionKey) this.#records.delete(digest(this.#sessionKey));
    const record = this.#create(CONNECTION_KEY_PURPOSES.session, null, 'multi-use');
    this.#sessionKey = record.key;
    return record.key;
  }
  createSetup({ ttlMs = 10 * 60_000 } = {}) {
    return this.#create(CONNECTION_KEY_PURPOSES.setup, ttlMs, 'single-use');
  }
  createOneTimeConnection({ ttlMs = 10 * 60_000 } = {}) {
    return this.#create(CONNECTION_KEY_PURPOSES.once, ttlMs, 'single-use');
  }
  clearPurpose(purpose) {
    if (!PURPOSE_CODES.has(purpose)) throw new Error('Invalid connection-key purpose');
    for (const [lookup, record] of this.#records)
      if (record.purpose === purpose) this.#records.delete(lookup);
    if (purpose === CONNECTION_KEY_PURPOSES.session) this.#sessionKey = null;
  }
  #create(purpose, ttlMs, usage) {
    if (ttlMs !== null && (!Number.isSafeInteger(ttlMs) || ttlMs < 1))
      throw new Error('Invalid connection-key lifetime');
    let key, lookup;
    do {
      key = generate(purpose);
      lookup = digest(key);
    } while (this.#records.has(lookup));
    const record = {
      purpose,
      usage,
      createdAt: this.clock(),
      expiresAt: ttlMs === null ? null : this.clock() + ttlMs,
    };
    this.#records.set(lookup, record);
    return { key, ...record };
  }
  inspect(value) {
    const key = normalizePassword(value);
    const purpose = connectionKeyPurpose(key);
    if (!key || !purpose) return null;
    const lookup = digest(key);
    const record = this.#records.get(lookup);
    if (!record || record.purpose !== purpose) return null;
    if (record.expiresAt !== null && this.clock() >= record.expiresAt) {
      this.#records.delete(lookup);
      return null;
    }
    return { ...record };
  }
  use(value, expectedPurpose) {
    const key = normalizePassword(value);
    const record = this.inspect(key);
    if (!record || record.purpose !== expectedPurpose) return null;
    if (record.usage === 'single-use') this.#records.delete(digest(key));
    return record;
  }
}
