import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { CONNECTION_KEY_PURPOSES } from './connection-keys.mjs';

const scrypt = promisify(scryptCallback);
const EMPTY = Object.freeze({ version: 1, clients: [] });
// 'default' follows the Access page's keyboard-and-mouse setting; the others override it per client.
export const CLIENT_PERMISSIONS = Object.freeze(['default', 'approval', 'available', 'view-only']);
const LEGACY_PERMISSIONS = { 'request-control': 'approval' };

function hash(value) {
  return createHash('sha256').update(value).digest('base64url');
}
function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function text(value, name, { min = 1, max = 128 } = {}) {
  if (
    typeof value !== 'string' ||
    value.trim().length < min ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new Error(`Invalid ${name}`);
  return value.trim();
}
async function passwordVerifier(password, salt = randomBytes(16).toString('base64url')) {
  const normalized = text(password, 'password', { min: 10, max: 256 });
  return {
    salt,
    hash: Buffer.from(await scrypt(normalized, salt, 32)).toString('base64url'),
  };
}
function validate(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.clients))
    throw new Error('Invalid approved clients');
  return {
    version: 1,
    clients: value.clients.map((row) => {
      if (
        !row ||
        typeof row !== 'object' ||
        typeof row.secretHash !== 'string' ||
        !row.password ||
        typeof row.password.salt !== 'string' ||
        typeof row.password.hash !== 'string'
      )
        throw new Error('Invalid approved client');
      const client = structuredClone(row);
      client.permission = LEGACY_PERMISSIONS[client.permission] ?? client.permission;
      if (!CLIENT_PERMISSIONS.includes(client.permission)) client.permission = 'default';
      return client;
    }),
  };
}
async function read(filename) {
  if (!filename) return structuredClone(EMPTY);
  try {
    return validate(JSON.parse(await readFile(filename, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(EMPTY);
    throw error;
  }
}

export class ApprovedClientStore {
  #value;
  #pending = new Map();
  #attempts = new Map();
  #queue = Promise.resolve();
  constructor(filename, value, { keys, clock, maxAttempts, windowMs }) {
    this.filename = filename;
    this.#value = value;
    this.keys = keys;
    this.clock = clock;
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
  }
  static async open(
    filename,
    { keys, clock = () => Date.now(), maxAttempts = 5, windowMs = 60_000 } = {},
  ) {
    if (!keys) throw new Error('Connection-key registry is required');
    return new ApprovedClientStore(filename, await read(filename), {
      keys,
      clock,
      maxAttempts,
      windowMs,
    });
  }
  async submit(input) {
    const deviceName = text(input.deviceName, 'device name', { max: 120 });
    const username = text(input.username, 'username', { max: 64 });
    const installationId = text(input.installationId, 'installation ID', { max: 128 });
    const client = text(input.client, 'client', { max: 120 });
    const network =
      typeof input.network === 'string' ? text(input.network, 'network', { min: 0, max: 120 }) : '';
    const password = await passwordVerifier(input.password);
    if (!this.keys.use(input.key, CONNECTION_KEY_PURPOSES.setup))
      throw new Error('Invalid client setup key');
    const requestId = randomUUID();
    const claimToken = randomBytes(32).toString('base64url');
    this.#pending.set(requestId, {
      requestId,
      deviceName,
      username,
      installationId,
      client,
      network,
      password,
      claimHash: hash(claimToken),
      requestedAt: this.clock(),
      state: 'pending',
    });
    return { requestId, claimToken };
  }
  status(sessions = []) {
    const connected = new Set(sessions.map((row) => row.approvedClientId).filter(Boolean));
    return {
      pending: [...this.#pending.values()]
        .filter((row) => row.state === 'pending')
        .map((row) => ({
          id: row.requestId,
          deviceName: row.deviceName,
          username: row.username,
          client: row.client,
          network: row.network,
          requestedAt: row.requestedAt,
        })),
      approved: this.#value.clients.map((row) => ({
        id: row.id,
        deviceName: row.deviceName,
        username: row.username,
        client: row.client,
        network: row.network,
        connected: connected.has(row.id),
        permission: row.permission,
        lastConnectedAt: row.lastConnectedAt,
      })),
    };
  }
  registrationStatus(requestId, claimToken) {
    const row = this.#pending.get(requestId);
    if (!row || !safeEqual(row.claimHash, hash(String(claimToken)))) return { state: 'invalid' };
    if (row.state === 'pending') return { state: 'pending' };
    if (row.state === 'rejected') return { state: 'rejected' };
    if (row.claimed) return { state: 'approved', claimed: true };
    row.claimed = true;
    const result = {
      state: 'approved',
      clientId: row.clientId,
      clientSecret: row.clientSecret,
      username: row.username,
    };
    row.clientSecret = null;
    return result;
  }
  approve(requestId) {
    const operation = this.#queue.then(async () => {
      const row = this.#pending.get(requestId);
      if (!row || row.state !== 'pending') throw new Error('Unknown pending client');
      const clientSecret = randomBytes(32).toString('base64url');
      const clientId = randomUUID();
      this.#value.clients.push({
        id: clientId,
        deviceName: row.deviceName,
        username: row.username,
        installationId: row.installationId,
        client: row.client,
        network: row.network,
        permission: 'default',
        createdAt: this.clock(),
        lastConnectedAt: null,
        password: row.password,
        secretHash: hash(clientSecret),
      });
      await this.#write();
      Object.assign(row, { state: 'approved', clientId, clientSecret });
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
  reject(requestId) {
    const row = this.#pending.get(requestId);
    if (!row || row.state !== 'pending') throw new Error('Unknown pending client');
    row.state = 'rejected';
    row.password = null;
  }
  async authenticate(input, clientKey = 'unknown') {
    const attemptKey = `${String(input.clientId).slice(0, 128)}:${clientKey}`;
    const now = this.clock();
    if (this.#attempts.size >= 1024 && !this.#attempts.has(attemptKey)) return null;
    const attempts = (this.#attempts.get(attemptKey) ?? []).filter(
      (time) => now - time < this.windowMs,
    );
    if (attempts.length >= this.maxAttempts) {
      this.#attempts.set(attemptKey, attempts);
      return null;
    }
    const row = this.#value.clients.find(
      (candidate) => candidate.id === input.clientId && candidate.username === input.username,
    );
    if (!row || !safeEqual(row.secretHash, hash(String(input.clientSecret)))) {
      attempts.push(now);
      this.#attempts.set(attemptKey, attempts);
      return null;
    }
    const candidate = await passwordVerifier(input.password, row.password.salt).catch(() => null);
    if (!candidate || !safeEqual(row.password.hash, candidate.hash)) {
      attempts.push(now);
      this.#attempts.set(attemptKey, attempts);
      return null;
    }
    this.#attempts.delete(attemptKey);
    return {
      id: row.id,
      deviceName: row.deviceName,
      username: row.username,
      permission: row.permission,
    };
  }
  markConnected(clientId) {
    const operation = this.#queue.then(async () => {
      const row = this.#value.clients.find((candidate) => candidate.id === clientId);
      if (!row) throw new Error('Unknown approved client');
      row.lastConnectedAt = this.clock();
      await this.#write();
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
  remove(clientId) {
    const operation = this.#queue.then(async () => {
      const length = this.#value.clients.length;
      this.#value.clients = this.#value.clients.filter((row) => row.id !== clientId);
      if (this.#value.clients.length === length) throw new Error('Unknown approved client');
      await this.#write();
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
  permission(clientId) {
    return this.#value.clients.find((candidate) => candidate.id === clientId)?.permission ?? null;
  }
  setPermission(clientId, permission) {
    const operation = this.#queue.then(async () => {
      if (!CLIENT_PERMISSIONS.includes(permission))
        throw new Error('Invalid client permission');
      const row = this.#value.clients.find((candidate) => candidate.id === clientId);
      if (!row) throw new Error('Unknown approved client');
      row.permission = permission;
      await this.#write();
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
  async #write() {
    if (!this.filename) return;
    await mkdir(dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(this.#value));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await rename(temporary, this.filename);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}
