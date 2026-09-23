import { randomUUID } from 'node:crypto';
import { chooseAudioMode } from './audio.mjs';
import { CONNECTION_KEY_PURPOSES, ConnectionKeyRegistry } from './connection-keys.mjs';

const MEDIA_STATUS = Object.freeze({ state: 'unavailable' });

export function isValidPasswordFormat(value) {
  return (
    typeof value === 'string' &&
    /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/.test(value)
  );
}

export class SessionStore {
  constructor({
    clock = () => Date.now(),
    sessionTtlMs = 20_000,
    maxAttempts = 5,
    windowMs = 60 * 1_000,
    onRevoke = () => {},
    onConnect = () => {},
    maxSessions = 1,
    keys = new ConnectionKeyRegistry({ clock }),
  } = {}) {
    // A function limit is read at each admission so saved settings apply without a restart.
    this.#limit = typeof maxSessions === 'function' ? maxSessions : () => maxSessions;
    void this.maxSessions;
    this.clock = clock;
    this.sessionTtlMs = sessionTtlMs;
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.onRevoke = onRevoke;
    this.onConnect = onConnect;
    this.keys = keys;
    this._password = keys.sessionKey;
    this._sessions = new Map();
    this._failedAttempts = new Map();
  }

  #limit;

  get maxSessions() {
    const limit = this.#limit();
    if (!Number.isInteger(limit) || limit < 1 || limit > 64)
      throw new Error('Invalid session limit');
    return limit;
  }

  get password() {
    return this._password;
  }

  list() {
    this.sweep();
    return [...this._sessions.values()].map((session) => structuredClone(session));
  }

  rotatePassword() {
    for (const id of this._sessions.keys()) this.disconnect(id);
    return this.rotateConnectionKey();
  }

  rotateConnectionKey() {
    this._password = this.keys.rotateSession();
    return this._password;
  }

  connect(password, clientKey = 'unknown', userAgent = '') {
    this.sweep();
    const now = this.clock();
    if (this._failedAttempts.size >= 1024 && !this._failedAttempts.has(clientKey))
      this._failedAttempts.delete(this._failedAttempts.keys().next().value);
    const attempts = (this._failedAttempts.get(clientKey) ?? []).filter(
      (time) => now - time < this.windowMs,
    );

    if (attempts.length >= this.maxAttempts) {
      this._failedAttempts.set(clientKey, attempts);
      return { ok: false, reason: 'rate-limited' };
    }

    const record = this.keys.inspect(password);
    if (
      !record ||
      ![CONNECTION_KEY_PURPOSES.session, CONNECTION_KEY_PURPOSES.once].includes(record.purpose)
    ) {
      attempts.push(now);
      this._failedAttempts.set(clientKey, attempts);
      return { ok: false, reason: 'invalid-password' };
    }

    if (this._sessions.size >= this.maxSessions) return { ok: false, reason: 'busy' };
    if (!this.keys.use(password, record.purpose)) return { ok: false, reason: 'invalid-password' };
    this._failedAttempts.delete(clientKey);
    return this.#createSession(clientKey, userAgent);
  }

  connectApproved(approvedClient, clientKey = 'unknown', userAgent = '') {
    this.sweep();
    if (!approvedClient?.id) return { ok: false, reason: 'invalid-client' };
    if (this._sessions.size >= this.maxSessions) return { ok: false, reason: 'busy' };
    return this.#createSession(clientKey, userAgent, approvedClient);
  }

  #createSession(clientKey, userAgent, approvedClient = null) {
    const now = this.clock();
    const sessionId = randomUUID();
    this._sessions.set(sessionId, {
      sessionId,
      clientKey,
      approvedClientId: approvedClient?.id ?? null,
      device: /iPhone/i.test(userAgent)
        ? 'iPhone'
        : /iPad/i.test(userAgent)
          ? 'iPad'
          : /Macintosh/i.test(userAgent)
            ? 'Mac browser'
            : /Windows/i.test(userAgent)
              ? 'Windows browser'
              : /Android/i.test(userAgent)
                ? 'Android device'
                : 'Browser client',
      createdAt: now,
      lastSeenAt: now,
      controlEnabled: false,
      profile: null,
      audio: chooseAudioMode(),
    });
    this.onConnect(sessionId);
    return {
      ok: true,
      sessionId,
      controlEnabled: false,
      audio: chooseAudioMode(),
      media: { ...MEDIA_STATUS },
    };
  }

  get(sessionId) {
    const session = this._sessions.get(sessionId);
    if (!session) return null;

    if (this.clock() - session.lastSeenAt >= this.sessionTtlMs) {
      this.disconnect(sessionId);
      return null;
    }

    session.lastSeenAt = this.clock();
    return { ...session };
  }

  replaceSession(sessionId) {
    const previous = this.get(sessionId);
    if (!previous) return { ok: false, reason: 'inactive-session' };
    this.disconnect(sessionId);
    const replacementId = randomUUID();
    this._sessions.set(replacementId, {
      ...previous,
      sessionId: replacementId,
      createdAt: this.clock(),
      lastSeenAt: this.clock(),
      controlEnabled: false,
    });
    return { ok: true, sessionId: replacementId };
  }

  setControl(sessionId, enabled) {
    const session = this.get(sessionId);
    if (!session) return { ok: false, reason: 'inactive-session' };

    const storedSession = this._sessions.get(sessionId);
    storedSession.controlEnabled = enabled === true;
    storedSession.lastSeenAt = this.clock();
    return { ok: true, controlEnabled: storedSession.controlEnabled };
  }

  setProfile(sessionId, profile) {
    const session = this._sessions.get(sessionId);
    if (!session) return false;
    session.profile = { ...profile };
    return true;
  }
  setDisplay(sessionId, display, revision) {
    const session = this._sessions.get(sessionId);
    if (session) {
      session.display = display ? { ...display } : null;
      session.inventoryRevision = revision;
    }
  }
  setAudio(sessionId, audio) {
    const session = this._sessions.get(sessionId);
    if (!session) return false;
    session.audio = { ...audio };
    return true;
  }

  setPolicyRevision(sessionId, revision) {
    const session = this._sessions.get(sessionId);
    if (session) session.policyRevision = revision;
  }

  stop() {
    this.rotatePassword();
  }

  disconnect(sessionId) {
    if (!this._sessions.delete(sessionId)) return false;
    this.onRevoke(sessionId);
    return true;
  }

  sweep() {
    const now = this.clock();
    for (const [id, session] of this._sessions) {
      if (now - session.lastSeenAt >= this.sessionTtlMs) this.disconnect(id);
    }
    for (const [key, times] of this._failedAttempts) {
      const recent = times.filter((time) => now - time < this.windowMs);
      if (recent.length) this._failedAttempts.set(key, recent);
      else this._failedAttempts.delete(key);
    }
  }
}
