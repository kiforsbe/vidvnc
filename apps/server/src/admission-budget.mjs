const MINUTE = 60_000;
const MAX_SCRYPT = 4;

function recent(times, now, windowMs) {
  return times.filter((time) => now - time < windowMs);
}

export class AdmissionBudget {
  #classes = new Map();
  #rolling = new Map();
  #lastNow = 0;
  #activeScrypt = 0;

  constructor({ clock = () => performance.now(), maxSources = 1024 } = {}) {
    if (!Number.isInteger(maxSources) || maxSources < 1)
      throw new Error('Invalid admission source limit');
    this.clock = clock;
    this.maxSources = maxSources;
  }

  #now() {
    this.#lastNow = Math.max(this.#lastNow, this.clock());
    return this.#lastNow;
  }

  #boundedRow(map, key, make) {
    if (map.has(key)) {
      const row = map.get(key);
      map.delete(key);
      map.set(key, row);
      return row;
    }
    if (map.size >= this.maxSources) map.delete(map.keys().next().value);
    const row = make();
    map.set(key, row);
    return row;
  }

  #reserveClass(kind, source, config) {
    if (!config) return null;
    const { generation, globalLimit, sourceLimit } = config;
    if (
      typeof generation !== 'string' ||
      !Number.isInteger(globalLimit) ||
      globalLimit < 1 ||
      globalLimit > 20 ||
      !Number.isInteger(sourceLimit) ||
      sourceLimit < 1 ||
      sourceLimit > 5 ||
      sourceLimit > globalLimit
    )
      throw new Error('Invalid key-admission policy');
    let state = this.#classes.get(kind);
    if (!state || state.generation !== generation) {
      state = { generation, failures: 0, pending: 0, sources: new Map() };
      this.#classes.set(kind, state);
    }
    if (state.failures + state.pending >= globalLimit) return null;
    const row = this.#boundedRow(state.sources, String(source), () => ({
      failures: 0,
      pending: 0,
    }));
    if (row.failures + row.pending >= sourceLimit) return null;
    state.pending++;
    row.pending++;
    let finished = false;
    return {
      accepts: (purpose) =>
        kind === 'session'
          ? purpose === 'session'
          : purpose === 'approved-client-setup' || purpose === 'one-time-connection',
      finish: (outcome) => {
        if (finished) return;
        finished = true;
        state.pending--;
        row.pending--;
        if (outcome === false) {
          state.failures++;
          if (state.sources.get(String(source)) === row) row.failures++;
        }
      },
    };
  }

  #reserveRolling(kind, source, globalLimit, sourceLimit, windowMs, identity, identityLimit) {
    const now = this.#now();
    let state = this.#rolling.get(kind);
    if (!state) {
      state = { global: [], sources: new Map(), identities: new Map() };
      this.#rolling.set(kind, state);
    }
    state.global = recent(state.global, now, windowMs);
    if (state.global.length >= globalLimit) return false;
    const sourceTimes = this.#boundedRow(state.sources, String(source), () => []);
    const sourceRecent = recent(sourceTimes, now, windowMs);
    sourceTimes.splice(0, sourceTimes.length, ...sourceRecent);
    if (sourceTimes.length >= sourceLimit) return false;
    let identityTimes = null;
    if (identity !== undefined) {
      identityTimes = this.#boundedRow(state.identities, String(identity).slice(0, 128), () => []);
      const identityRecent = recent(identityTimes, now, windowMs);
      identityTimes.splice(0, identityTimes.length, ...identityRecent);
      if (identityTimes.length >= identityLimit) return false;
    }
    state.global.push(now);
    sourceTimes.push(now);
    identityTimes?.push(now);
    return true;
  }

  beginKeyStart(source, { ephemeral, session }) {
    if (!this.#reserveRolling('key-start', source, 120, 10, MINUTE)) return { ok: false };
    const reserved = [
      this.#reserveClass('ephemeral', source, ephemeral),
      this.#reserveClass('session', source, session),
    ].filter(Boolean);
    if (!reserved.length) return { ok: false };
    const allowsPurpose = (purpose) => reserved.some((item) => item.accepts(purpose));
    let finished = false;
    return {
      ok: true,
      allowsPurpose,
      finish: (purpose, valid) => {
        if (finished) return;
        finished = true;
        const accepted = valid && allowsPurpose(purpose);
        for (const item of reserved)
          item.finish(accepted ? (item.accepts(purpose) ? true : null) : false);
      },
    };
  }

  beginSignIn(source, clientId) {
    return {
      ok: this.#reserveRolling('credentials', source, 120, 10, MINUTE, clientId ?? 'unknown', 10),
      finish() {},
    };
  }

  beginRegistration(source) {
    return { ok: this.#reserveRolling('credentials', source, 120, 10, MINUTE), finish() {} };
  }

  beginStatus(source) {
    return { ok: this.#reserveRolling('status', source, 600, 60, MINUTE), finish() {} };
  }

  async withScrypt(work) {
    if (this.#activeScrypt >= MAX_SCRYPT)
      throw Object.assign(new Error('Password verification busy'), { status: 503 });
    this.#activeScrypt++;
    try {
      return await work();
    } finally {
      this.#activeScrypt--;
    }
  }

  stats() {
    const summary = (kind) => {
      const state = this.#classes.get(kind);
      return state
        ? {
            generation: state.generation,
            failures: state.failures,
            pending: state.pending,
            sources: state.sources.size,
          }
        : { generation: null, failures: 0, pending: 0, sources: 0 };
    };
    return {
      ephemeral: summary('ephemeral'),
      session: summary('session'),
      activeScrypt: this.#activeScrypt,
    };
  }
}
