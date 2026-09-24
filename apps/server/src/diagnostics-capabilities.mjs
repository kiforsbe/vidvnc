import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

function digest(token) {
  return createHash('sha256').update(token).digest();
}

export class DiagnosticsCapabilities {
  #hashes = [];
  #lastNow = 0;

  constructor({ clock = Date.now, ttlMs = 900_000, maxOutstanding = 4 } = {}) {
    if (typeof clock !== 'function') throw new Error('Invalid diagnostics clock');
    if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 900_000)
      throw new Error('Invalid diagnostics capability lifetime');
    if (!Number.isInteger(maxOutstanding) || maxOutstanding < 1 || maxOutstanding > 4)
      throw new Error('Invalid diagnostics outstanding limit');
    this.clock = clock;
    this.ttlMs = ttlMs;
    this.maxOutstanding = maxOutstanding;
  }

  #now() {
    this.#lastNow = Math.max(this.#lastNow, this.clock());
    return this.#lastNow;
  }

  sweep() {
    const now = this.#now();
    this.#hashes = this.#hashes.filter((row) => now < row.expiresAt);
  }

  issue() {
    this.sweep();
    while (this.#hashes.length >= this.maxOutstanding) this.#hashes.shift();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.#now() + this.ttlMs;
    this.#hashes.push({ digest: digest(token), expiresAt });
    return { token, expiresAt };
  }

  allows(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
    this.sweep();
    const candidate = digest(token);
    let matched = 0;
    for (const row of this.#hashes) matched |= Number(timingSafeEqual(row.digest, candidate));
    return matched !== 0;
  }
}
