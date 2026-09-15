import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { normalizePassword } from '@vidvnc/web-client/password-entry.js';
import { chooseAudioMode } from './audio.mjs';

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const PASSWORD_LENGTH = 8;
const PASSWORD_GROUP_SIZE = 4;
const MEDIA_STATUS = Object.freeze({ state: 'unavailable' });

function generatePassword() {
  let characters = '';
  const acceptedByteCount = Math.floor(256 / PASSWORD_ALPHABET.length) * PASSWORD_ALPHABET.length;

  while (characters.length < PASSWORD_LENGTH) {
    for (const byte of randomBytes(PASSWORD_LENGTH)) {
      if (byte >= acceptedByteCount) continue;
      characters += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
      if (characters.length === PASSWORD_LENGTH) break;
    }
  }

  return `${characters.slice(0, PASSWORD_GROUP_SIZE)}-${characters.slice(PASSWORD_GROUP_SIZE)}`;
}

function passwordsMatch(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function isValidPasswordFormat(value) {
  return typeof value === 'string' && /^[A-Z]{4}-[A-Z]{4}$/.test(value);
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
  } = {}) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 64)
      throw new Error('Invalid session limit');
    this.maxSessions = maxSessions;
    this.clock = clock;
    this.sessionTtlMs = sessionTtlMs;
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.onRevoke = onRevoke;
    this.onConnect = onConnect;
    this._password = generatePassword();
    this._sessions = new Map();
    this._failedAttempts = new Map();
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
    this._password = generatePassword();
    return this._password;
  }

  connect(password, clientKey = 'unknown', userAgent = '') {
    this.sweep();
    const now = this.clock();
    if (this._failedAttempts.size >= 1024 && !this._failedAttempts.has(clientKey))
      return { ok: false, reason: 'rate-limited' };
    const attempts = (this._failedAttempts.get(clientKey) ?? []).filter(
      (time) => now - time < this.windowMs,
    );

    if (attempts.length >= this.maxAttempts) {
      this._failedAttempts.set(clientKey, attempts);
      return { ok: false, reason: 'rate-limited' };
    }

    if (!passwordsMatch(normalizePassword(password), this._password)) {
      attempts.push(now);
      this._failedAttempts.set(clientKey, attempts);
      return { ok: false, reason: 'invalid-password' };
    }

    this._failedAttempts.delete(clientKey);
    if (this._sessions.size >= this.maxSessions) return { ok: false, reason: 'busy' };
    const sessionId = randomUUID();
    this._sessions.set(sessionId, {
      sessionId,
      clientKey,
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
