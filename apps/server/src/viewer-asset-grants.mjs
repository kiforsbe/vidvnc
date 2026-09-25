import { randomBytes } from 'node:crypto';

const COOKIE_NAME = 'vidvnc-viewer';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function normalizePeer(peer) {
  if (typeof peer !== 'string') return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(peer);
  return mapped ? mapped[1] : peer;
}

function readViewerCookie(header) {
  if (typeof header !== 'string' || header.length > 4096) return null;
  let value = null;
  for (const piece of header.split(';')) {
    const entry = piece.trim();
    const separator = entry.indexOf('=');
    if (separator < 0 || entry.slice(0, separator) !== COOKIE_NAME) continue;
    if (value !== null) return null;
    value = entry.slice(separator + 1);
  }
  return TOKEN_PATTERN.test(value ?? '') ? value : null;
}

export const viewerCookie = (value, secure) =>
  `${COOKIE_NAME}=${value}; Path=/viewer; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;

export const clearViewerCookie = (secure) =>
  `${COOKIE_NAME}=; Path=/viewer; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;

export class ViewerAssetGrants {
  #byToken = new Map();
  #bySession = new Map();

  issue(sessionId, peer) {
    const normalized = normalizePeer(peer);
    if (typeof sessionId !== 'string' || !sessionId || !normalized)
      throw new Error('Cannot issue a viewer grant without a session and peer');
    this.revoke(sessionId);
    let value;
    do value = randomBytes(32).toString('base64url');
    while (this.#byToken.has(value));
    this.#byToken.set(value, { sessionId, peer: normalized });
    this.#bySession.set(sessionId, value);
    return value;
  }

  allows(cookieHeader, peer, sessionStore) {
    const value = readViewerCookie(cookieHeader);
    const normalized = normalizePeer(peer);
    if (!value || !normalized) return false;
    const grant = this.#byToken.get(value);
    if (!grant || grant.peer !== normalized) return false;
    const session = sessionStore.peek(grant.sessionId);
    if (!session) {
      this.revoke(grant.sessionId);
      return false;
    }
    return normalizePeer(session.clientKey) === normalized;
  }

  revoke(sessionId) {
    const value = this.#bySession.get(sessionId);
    if (value) this.#byToken.delete(value);
    this.#bySession.delete(sessionId);
  }

  clear() {
    this.#byToken.clear();
    this.#bySession.clear();
  }
}
