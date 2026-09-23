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
const CLAIM_TTL_MS = 600_000;
const MAX_PENDING = 64;
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
  #tickets = new Map();
  #submitting = 0;
  #attempts = new Map();
  #queue = Promise.resolve();
  constructor(filename, value, { keys, clock, maxAttempts, windowMs, admission }) {
    this.filename = filename;
    this.#value = value;
    this.keys = keys;
    this.clock = clock;
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.admission = admission;
  }
  static async open(
    filename,
    { keys, clock = () => Date.now(), maxAttempts = 5, windowMs = 60_000, admission = null } = {},
  ) {
    if (!keys) throw new Error('Connection-key registry is required');
    return new ApprovedClientStore(filename, await read(filename), {
      keys,
      clock,
      maxAttempts,
      windowMs,
      admission,
    });
  }
  #expired(row) {
    return this.clock() >= row.requestedAt + CLAIM_TTL_MS;
  }
  #expiredUnclaimed(clientId) {
    return [...this.#pending.values()].some(
      (row) => row.clientId === clientId && !row.claimed && this.#expired(row),
    );
  }
  issueRegistrationTicket() {
    const now = this.clock();
    for (const [key, row] of this.#tickets) if (now >= row.expiresAt) this.#tickets.delete(key);
    if (this.#tickets.size >= MAX_PENDING) throw new Error('Registration ticket limit reached');
    const registrationTicket = randomBytes(32).toString('base64url');
    const expiresAt = now + CLAIM_TTL_MS;
    this.#tickets.set(hash(registrationTicket), { expiresAt, inUse: false });
    return { registrationTicket, expiresAt };
  }
  async submit(input) {
    await this.sweepExpired();
    const live = [...this.#pending.values()].filter((row) => !this.#expired(row)).length;
    if (live + this.#submitting >= MAX_PENDING) throw new Error('Too many pending client requests');
    const ticketKey =
      input.registrationTicket === undefined ? null : hash(String(input.registrationTicket));
    const ticket = ticketKey && this.#tickets.get(ticketKey);
    if (ticketKey && (!ticket || this.clock() >= ticket.expiresAt || ticket.inUse))
      throw new Error('Invalid registration ticket');
    if (!ticketKey && this.keys.inspect(input.key)?.purpose !== CONNECTION_KEY_PURPOSES.setup)
      throw new Error('Invalid client setup key');
    if (ticket) ticket.inUse = true;
    this.#submitting++;
    try {
      const deviceName = text(input.deviceName, 'device name', { max: 120 });
      const username = text(input.username, 'username', { max: 64 });
      const installationId = text(input.installationId, 'installation ID', { max: 128 });
      const client = text(input.client, 'client', { max: 120 });
      const network =
        typeof input.network === 'string'
          ? text(input.network, 'network', { min: 0, max: 120 })
          : '';
      const password = this.admission
        ? await this.admission.withScrypt(() => passwordVerifier(input.password))
        : await passwordVerifier(input.password);
      if (ticket && this.clock() >= ticket.expiresAt)
        throw new Error('Invalid registration ticket');
      if (ticket) this.#tickets.delete(ticketKey);
      else if (!this.keys.use(input.key, CONNECTION_KEY_PURPOSES.setup))
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
    } finally {
      if (ticket) ticket.inUse = false;
      this.#submitting--;
    }
  }
  status(sessions = []) {
    const connected = new Set(sessions.map((row) => row.approvedClientId).filter(Boolean));
    return {
      pending: [...this.#pending.values()]
        .filter((row) => row.state === 'pending' && !this.#expired(row))
        .map((row) => ({
          id: row.requestId,
          deviceName: row.deviceName,
          username: row.username,
          client: row.client,
          network: row.network,
          requestedAt: row.requestedAt,
        })),
      approved: this.#value.clients
        .filter((row) => !this.#expiredUnclaimed(row.id))
        .map((row) => ({
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
    if (!row || this.#expired(row) || !safeEqual(row.claimHash, hash(String(claimToken))))
      return { state: 'invalid' };
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
      await this.#sweepExpiredInner();
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
    if (!row || this.#expired(row) || row.state !== 'pending')
      throw new Error('Unknown pending client');
    row.state = 'rejected';
    row.password = null;
  }
  async authenticate(input, clientKey = 'unknown') {
    if (this.#expiredUnclaimed(input.clientId)) return null;
    const attemptKey = `${String(input.clientId).slice(0, 128)}:${clientKey}`;
    const now = this.clock();
    if (this.#attempts.size >= 1024 && !this.#attempts.has(attemptKey))
      this.#attempts.delete(this.#attempts.keys().next().value);
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
    let candidate;
    try {
      candidate = this.admission
        ? await this.admission.withScrypt(() => passwordVerifier(input.password, row.password.salt))
        : await passwordVerifier(input.password, row.password.salt);
    } catch (error) {
      if (error.status === 503) throw error;
      candidate = null;
    }
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
      await this.#sweepExpiredInner();
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
      await this.#sweepExpiredInner();
      const length = this.#value.clients.length;
      this.#value.clients = this.#value.clients.filter((row) => row.id !== clientId);
      if (this.#value.clients.length === length) throw new Error('Unknown approved client');
      await this.#write();
      for (const [id, row] of this.#pending)
        if (row.clientId === clientId) this.#pending.delete(id);
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
  permission(clientId) {
    if (this.#expiredUnclaimed(clientId)) return null;
    return this.#value.clients.find((candidate) => candidate.id === clientId)?.permission ?? null;
  }
  setPermission(clientId, permission) {
    const operation = this.#queue.then(async () => {
      await this.#sweepExpiredInner();
      if (!CLIENT_PERMISSIONS.includes(permission)) throw new Error('Invalid client permission');
      const row = this.#value.clients.find((candidate) => candidate.id === clientId);
      if (!row) throw new Error('Unknown approved client');
      row.permission = permission;
      await this.#write();
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }
  async #sweepExpiredInner() {
    const expired = [...this.#pending].filter(([, row]) => this.#expired(row));
    const unclaimed = new Set(
      expired
        .filter(([, row]) => row.state === 'approved' && !row.claimed)
        .map(([, row]) => row.clientId),
    );
    if (unclaimed.size) {
      this.#value.clients = this.#value.clients.filter((row) => !unclaimed.has(row.id));
      await this.#write();
    }
    for (const [id] of expired) this.#pending.delete(id);
    for (const [key, row] of this.#tickets)
      if (this.clock() >= row.expiresAt) this.#tickets.delete(key);
  }
  sweepExpired() {
    const operation = this.#queue.then(() => this.#sweepExpiredInner());
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
