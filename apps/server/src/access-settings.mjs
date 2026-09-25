import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';

// Each connected device may run two video encoders; eight devices already exceed the host stream budget.
export const MAX_SESSIONS_LIMIT = 8;
export const MAX_PUBLIC_HOSTNAMES = 8;
const DEFAULTS = Object.freeze({
  revision: 0,
  defaultControl: 'approval',
  connectionMode: 'session-key',
  maxSessions: 4,
  shortCodeTtlSeconds: 300,
  shortCodeMaxFailures: 20,
  shortCodePerSourceMaxFailures: 5,
  sessionPasswordMaxFailures: 20,
  defaultCodeAlphabet: 'letters-digits',
  localSessionNetworks: 'auto',
  publicName: 'VidVNC host',
  // Remote access (peer-network.mjs). Off, clients with an internet source address are
  // refused outright. On, they may reach HTTPS, sign in only as approved devices, and use
  // the names below; setup, one-time codes and trust enrolment stay on the local network.
  remoteAccess: false,
  // The DNS names or public IP addresses internet clients use for this PC: accepted as HTTP
  // Host values and added to the generated certificate while remote access is on.
  publicHostnames: Object.freeze([]),
  // The HTTPS port internet devices use when the router forwards a different public port
  // (usually 443) to this PC's HTTPS port. null: the same port as the HTTPS listener.
  publicPort: null,
  // The UDP (and ICE-TCP) ports media workers use, `{ min, max }`, so the router can forward
  // exactly that range to this PC. null lets the system pick any port, which works on the
  // local network but cannot be forwarded.
  mediaPorts: null,
});

export const MEDIA_PORT_LIMITS = Object.freeze({ lowest: 1024, fewest: 8, most: 1000 });

export function validMediaPorts(value) {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { min, max } = value;
  return (
    Object.keys(value).length === 2 &&
    Number.isInteger(min) &&
    Number.isInteger(max) &&
    min >= MEDIA_PORT_LIMITS.lowest &&
    max <= 65535 &&
    max - min + 1 >= MEDIA_PORT_LIMITS.fewest &&
    max - min + 1 <= MEDIA_PORT_LIMITS.most
  );
}

// A DNS name (dot-separated letters, digits and hyphens) or an IP address, lowercase and
// without brackets so it compares directly with a parsed Host header. null if neither.
export function normalizePublicHostname(value) {
  if (typeof value !== 'string') return null;
  let text = value.trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  if (text.endsWith('.')) text = text.slice(0, -1);
  if (isIP(text)) return text;
  const labels = text.split('.');
  if (
    text.length > 253 ||
    labels.length < 2 ||
    !labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    /^\d+$/.test(labels.at(-1))
  )
    return null;
  return text;
}

function validPublicHostnames(list) {
  return (
    Array.isArray(list) &&
    list.length <= MAX_PUBLIC_HOSTNAMES &&
    list.every((name) => normalizePublicHostname(name) === name) &&
    new Set(list).size === list.length
  );
}

function bounded(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

export function validNetworkCidr(value) {
  if (typeof value !== 'string') return false;
  const match = /^(.+)\/(\d{1,3})$/.exec(value);
  if (!match) return false;
  const family = isIP(match[1]);
  return family !== 0 && Number(match[2]) <= (family === 4 ? 32 : 128);
}

function validate(value) {
  const next = { ...DEFAULTS, ...value };
  // Remote access trusts the connection's source address to tell the internet from the LAN.
  // A router or program that rewrites that address would make internet clients look local,
  // so while remote access is on no short-code admission is allowed for anyone: approved
  // devices only, and setup codes still need the owner's approval.
  if (next.remoteAccess === true && next.connectionMode !== 'approved-only')
    throw new Error('Remote access requires connection mode approved-only');
  if (typeof next.publicName !== 'string') throw new Error('Invalid public name');
  next.publicName = next.publicName.trim();
  if (
    [...next.publicName].length < 1 ||
    [...next.publicName].length > 80 ||
    /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(
      next.publicName,
    )
  )
    throw new Error('Invalid public name');
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
    !bounded(next.shortCodeTtlSeconds, 60, 600) ||
    !bounded(next.shortCodeMaxFailures, 1, 20) ||
    !bounded(next.shortCodePerSourceMaxFailures, 1, 5) ||
    next.shortCodePerSourceMaxFailures > next.shortCodeMaxFailures ||
    !bounded(next.sessionPasswordMaxFailures, 1, 20) ||
    !['letters-digits', 'letters'].includes(next.defaultCodeAlphabet) ||
    (next.localSessionNetworks !== 'auto' &&
      (!Array.isArray(next.localSessionNetworks) ||
        next.localSessionNetworks.length < 1 ||
        next.localSessionNetworks.length > 16 ||
        !next.localSessionNetworks.every(validNetworkCidr))) ||
    typeof next.remoteAccess !== 'boolean' ||
    !validPublicHostnames(next.publicHostnames) ||
    (next.remoteAccess && next.publicHostnames.length === 0) ||
    !validMediaPorts(next.mediaPorts) ||
    (next.publicPort !== null && !bounded(next.publicPort, 1, 65535)) ||
    Object.keys(value).some((key) => !Object.hasOwn(DEFAULTS, key))
  )
    throw new Error('Invalid access settings');
  return { ...next, publicHostnames: [...next.publicHostnames] };
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
  #listeners = new Set();
  constructor(filename, value) {
    this.#filename = filename;
    this.#value = value;
  }
  static async open(filename) {
    return new AccessSettings(filename, await read(filename));
  }
  snapshot() {
    return structuredClone(this.#value);
  }
  // Called with (next, previous) after every saved change, whoever saved it.
  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
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
        const previous = this.snapshot();
        this.#value = next;
        for (const listener of this.#listeners) {
          try {
            listener(this.snapshot(), previous);
          } catch {
            // A listener's failure must not turn a saved change into a reported failure.
          }
        }
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
