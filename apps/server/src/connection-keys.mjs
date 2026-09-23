import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { normalizePassword } from '@vidvnc/web-client/password-entry.js';

export const CODE_ALPHABETS = Object.freeze({
  'letters-digits': '23456789ABCDEFGHJKMNPQRSTUVWXYZ',
  letters: 'ABCDEFGHJKMNPQRSTUVWXYZ',
});
export const CONNECTION_KEY_PURPOSES = Object.freeze({
  session: 'session',
  setup: 'approved-client-setup',
  once: 'one-time-connection',
});
const DEFAULT_LIMITS = Object.freeze({ globalLimit: 20, sourceLimit: 5 });

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

function generate(alphabet) {
  const symbols = CODE_ALPHABETS[alphabet];
  if (!symbols) throw new Error('Invalid code alphabet');
  let raw = '';
  while (raw.length < 8) raw += symbols[randomIndex(symbols.length)];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function boundedLimits(limits) {
  if (
    !limits ||
    !Number.isInteger(limits.globalLimit) ||
    limits.globalLimit < 1 ||
    limits.globalLimit > 20 ||
    !Number.isInteger(limits.sourceLimit) ||
    limits.sourceLimit < 1 ||
    limits.sourceLimit > 5 ||
    limits.sourceLimit > limits.globalLimit
  )
    throw new Error('Invalid connection-key attempt limits');
  return { globalLimit: limits.globalLimit, sourceLimit: limits.sourceLimit };
}

export class ConnectionKeyRegistry {
  #records = new Map();
  #sessionKey = null;
  #ephemeralKey = null;
  constructor({ clock = () => Date.now(), alphabet = 'letters-digits' } = {}) {
    this.clock = clock;
    this.alphabet = alphabet;
    if (!CODE_ALPHABETS[alphabet]) throw new Error('Invalid code alphabet');
    this.rotateSession();
  }
  get sessionKey() {
    return this.#sessionKey;
  }
  rotateSession(alphabet = this.alphabet, limits = DEFAULT_LIMITS) {
    if (this.#sessionKey) this.#records.delete(digest(this.#sessionKey));
    const record = this.#create(
      CONNECTION_KEY_PURPOSES.session,
      null,
      'multi-use',
      alphabet,
      limits,
    );
    this.#sessionKey = record.key;
    return record.key;
  }
  createSetup({ ttlMs = 300_000, alphabet = this.alphabet, limits = DEFAULT_LIMITS } = {}) {
    return this.#create(CONNECTION_KEY_PURPOSES.setup, ttlMs, 'single-use', alphabet, limits);
  }
  createOneTimeConnection({
    ttlMs = 300_000,
    alphabet = this.alphabet,
    limits = DEFAULT_LIMITS,
  } = {}) {
    return this.#create(CONNECTION_KEY_PURPOSES.once, ttlMs, 'single-use', alphabet, limits);
  }
  clearPurpose(purpose) {
    if (!Object.values(CONNECTION_KEY_PURPOSES).includes(purpose))
      throw new Error('Invalid connection-key purpose');
    for (const [lookup, record] of this.#records)
      if (record.purpose === purpose) this.#records.delete(lookup);
    if (purpose === CONNECTION_KEY_PURPOSES.session) this.#sessionKey = null;
    else if (this.#ephemeralKey && !this.inspect(this.#ephemeralKey)) this.#ephemeralKey = null;
  }
  activeEphemeral() {
    const record = this.#ephemeralKey && this.inspect(this.#ephemeralKey);
    return record ? this.#admission(record) : null;
  }
  activeSession() {
    const record = this.#sessionKey && this.inspect(this.#sessionKey);
    return record ? this.#admission(record) : null;
  }
  #admission(record) {
    return {
      generation: record.generation,
      globalLimit: record.globalLimit,
      sourceLimit: record.sourceLimit,
    };
  }
  #create(purpose, ttlMs, usage, alphabet, limits) {
    if (ttlMs !== null && (!Number.isSafeInteger(ttlMs) || ttlMs < 1))
      throw new Error('Invalid connection-key lifetime');
    if (!CODE_ALPHABETS[alphabet]) throw new Error('Invalid code alphabet');
    const bounded = boundedLimits(limits);
    if (usage === 'single-use' && this.#ephemeralKey)
      this.#records.delete(digest(this.#ephemeralKey));
    let key, lookup;
    do {
      key = generate(alphabet);
      lookup = digest(key);
    } while (this.#records.has(lookup));
    const record = {
      purpose,
      usage,
      generation: randomUUID(),
      ...bounded,
      alphabet,
      createdAt: this.clock(),
      expiresAt: ttlMs === null ? null : this.clock() + ttlMs,
    };
    this.#records.set(lookup, record);
    if (usage === 'single-use') this.#ephemeralKey = key;
    return { key, ...record };
  }
  inspect(value) {
    const key = normalizePassword(value);
    if (!key) return null;
    const lookup = digest(key);
    const record = this.#records.get(lookup);
    if (!record) return null;
    if (record.expiresAt !== null && this.clock() >= record.expiresAt) {
      this.#records.delete(lookup);
      if (this.#ephemeralKey === key) this.#ephemeralKey = null;
      return null;
    }
    return { ...record };
  }
  use(value, expectedPurpose) {
    const key = normalizePassword(value);
    const record = this.inspect(key);
    if (!record || record.purpose !== expectedPurpose) return null;
    if (record.usage === 'single-use') {
      this.#records.delete(digest(key));
      if (this.#ephemeralKey === key) this.#ephemeralKey = null;
    }
    return record;
  }
}
