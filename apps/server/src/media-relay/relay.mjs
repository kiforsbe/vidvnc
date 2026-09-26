import { isIP } from 'node:net';
import { plainAddress, sourceGroup } from '../peer-network.mjs';
import { TYPES, parseStun, receiverUfrag, verifyIntegrity } from './stun.mjs';

// The authenticating media relay's core (design: docs/superpowers/specs/2026-09-26-r4-media-
// relay-and-privilege-split-design.md, Part A). It owns the one public media port and
// forwards a client's datagrams to the worker's loopback-only ICE socket only after the
// client has proved the session's ICE password. Sockets come from `createSocket`, so the
// logic runs unchanged against Node's dgram module or a test double.

export const RELAY_LIMITS = Object.freeze({
  registrations: 64,
  perUfrag: 4,
  pinsPerRegistration: 4,
  hintLanePerSecond: 200,
  strangerPerSource: 50,
  strangerTotal: 5000,
  pinIdleMs: 30_000,
  maxExpiresMs: 15_000,
  queuedPerPin: 16,
  socketBufferBytes: 4 * 1024 * 1024,
});

const DROP_REASONS = [
  'budget',
  'malformed',
  'unknown-ufrag',
  'bad-integrity',
  'username',
  'class',
  'cross-registration',
  'pins',
  'loopback-source',
];
const ICE_CHARS = /^[A-Za-z0-9+/]+$/;
const STREAM_ID = /^[A-Za-z0-9-]{1,64}$/;

const iceString = (value, min) =>
  typeof value === 'string' && value.length >= min && value.length <= 256 && ICE_CHARS.test(value);

// Validates a registration exactly as the relay protocol's `allow` command carries it.
export function validateAllow(message) {
  const {
    streamId,
    ufrag,
    pwd,
    clientUfrag,
    clientPwd,
    workerPort,
    clientHint = null,
    expiresMs,
  } = message ?? {};
  if (
    typeof streamId !== 'string' ||
    !STREAM_ID.test(streamId) ||
    !iceString(ufrag, 4) ||
    !iceString(clientUfrag, 4) ||
    !iceString(pwd, 22) ||
    !iceString(clientPwd, 22) ||
    !Number.isInteger(workerPort) ||
    workerPort < 1024 ||
    workerPort > 65535 ||
    (clientHint !== null && (typeof clientHint !== 'string' || !isIP(plainAddress(clientHint)))) ||
    !Number.isInteger(expiresMs) ||
    expiresMs < 1 ||
    expiresMs > RELAY_LIMITS.maxExpiresMs
  )
    throw new Error('Invalid relay registration');
  return { streamId, ufrag, pwd, clientUfrag, clientPwd, workerPort, clientHint, expiresMs };
}

const tupleText = (plain, port) => (isIP(plain) === 6 ? `[${plain}]:${port}` : `${plain}:${port}`);

// First byte of a datagram on an authenticated path (RFC 7983).
function datagramClass(byte) {
  if (byte <= 3) return 'stun';
  if (byte >= 20 && byte <= 63) return 'dtls';
  if (byte >= 128 && byte <= 191) return 'rtp';
  return null;
}

export class RelayCore {
  #createSocket;
  #now;
  #onEvent;
  #limits;
  #public = null;
  #registrations = new Map();
  #byUfrag = new Map();
  #byHint = new Map();
  #pins = new Map();
  #window = { start: -Infinity, total: 0, perSource: new Map(), perRegistration: new Map() };
  #counters = {
    dropped: Object.fromEntries(DROP_REASONS.map((reason) => [reason, 0])),
    forwarded: { toWorker: { packets: 0, bytes: 0 }, toClient: { packets: 0, bytes: 0 } },
    addressDiffers: 0,
  };

  constructor({ createSocket, now = () => Date.now(), onEvent = () => {}, limits = {} }) {
    this.#createSocket = createSocket;
    this.#now = now;
    this.#onEvent = onEvent;
    this.#limits = { ...RELAY_LIMITS, ...limits };
  }

  // Binds the public media port on every address, dual-stack where the system allows.
  async start(port) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid port');
    const buffers = {
      recvBufferSize: this.#limits.socketBufferBytes,
      sendBufferSize: this.#limits.socketBufferBytes,
    };
    const bind = (options, address) =>
      new Promise((resolve, reject) => {
        const socket = this.#createSocket({ ...options, ...buffers });
        const failed = (error) => {
          socket.close?.();
          reject(error);
        };
        socket.once('error', failed);
        socket.bind(port, address, () => {
          socket.off('error', failed);
          resolve(socket);
        });
      });
    let families = ['ipv6', 'ipv4'];
    try {
      this.#public = await bind({ type: 'udp6', ipv6Only: false }, '::');
    } catch (error) {
      if (error?.code === 'EADDRINUSE') throw error;
      this.#public = await bind({ type: 'udp4' }, '0.0.0.0');
      families = ['ipv4'];
    }
    this.#public.on('message', (message, rinfo) => this.receive(message, rinfo));
    this.#public.on('error', () => {});
    return { port, families };
  }

  allow(message) {
    const allowed = validateAllow(message);
    if (this.#registrations.has(allowed.streamId)) throw new Error('Duplicate relay registration');
    if (this.#registrations.size >= this.#limits.registrations)
      throw new Error('Relay registration limit reached');
    const sharing = this.#byUfrag.get(allowed.ufrag);
    if (sharing && sharing.size >= this.#limits.perUfrag)
      throw new Error('Too many registrations share this ufrag');
    const hint = allowed.clientHint === null ? null : plainAddress(allowed.clientHint);
    const registration = {
      ...allowed,
      hintGroup: hint === null ? null : sourceGroup(hint),
      hintFamily: hint === null ? 0 : isIP(hint),
      expiresAt: this.#now() + allowed.expiresMs,
      pinnedOnce: false,
      mismatchReported: false,
      pins: new Set(),
    };
    this.#registrations.set(registration.streamId, registration);
    this.#index(this.#byUfrag, registration.ufrag, registration);
    if (registration.hintGroup) this.#index(this.#byHint, registration.hintGroup, registration);
    return registration.streamId;
  }

  revoke(streamId) {
    const registration = this.#registrations.get(streamId);
    if (!registration) return false;
    for (const pin of [...registration.pins]) this.#unpin(pin, 'revoked');
    this.#registrations.delete(streamId);
    this.#unindex(this.#byUfrag, registration.ufrag, registration);
    if (registration.hintGroup) this.#unindex(this.#byHint, registration.hintGroup, registration);
    this.#window.perRegistration.delete(registration);
    return true;
  }

  // Expires registrations nobody authenticated for in time, and pins that went quiet.
  sweep() {
    const now = this.#now();
    for (const registration of [...this.#registrations.values()])
      if (!registration.pinnedOnce && now >= registration.expiresAt) {
        this.revoke(registration.streamId);
        this.#onEvent({ type: 'expired', streamId: registration.streamId });
      }
    for (const pin of [...this.#pins.values()])
      if (now - pin.lastSeen >= this.#limits.pinIdleMs) this.#unpin(pin, 'idle');
  }

  metrics() {
    return {
      dropped: { ...this.#counters.dropped },
      forwarded: {
        toWorker: { ...this.#counters.forwarded.toWorker },
        toClient: { ...this.#counters.forwarded.toClient },
      },
      addressDiffers: this.#counters.addressDiffers,
      registrations: this.#registrations.size,
      pins: this.#pins.size,
    };
  }

  close() {
    for (const streamId of [...this.#registrations.keys()]) this.revoke(streamId);
    this.#public?.close();
    this.#public = null;
  }

  // A datagram on the public media port.
  receive(message, rinfo) {
    const plain = plainAddress(rinfo.address);
    const pin = this.#pins.get(`${plain}|${rinfo.port}`);
    if (pin) return this.#fromPinned(pin, message);
    if (!this.#budget(plain)) return this.#drop('budget');
    const parsed = parseStun(message);
    if (!parsed || parsed.type !== TYPES.bindingRequest) return this.#drop('malformed');
    const candidates = this.#byUfrag.get(receiverUfrag(parsed));
    if (!candidates) return this.#drop('unknown-ufrag');
    let registration = null;
    for (const candidate of candidates)
      if (verifyIntegrity(message, parsed, candidate.pwd)) {
        registration = candidate;
        break;
      }
    if (!registration) return this.#drop('bad-integrity');
    if (parsed.username !== `${registration.ufrag}:${registration.clientUfrag}`)
      return this.#drop('username');
    if (registration.pins.size >= this.#limits.pinsPerRegistration) return this.#drop('pins');
    // The address the client used for HTTPS is a hint, never a gate: iCloud Private Relay,
    // carrier-grade NAT pooling and dual-stack clients legitimately differ.
    let hintMatched = null;
    if (registration.hintGroup && registration.hintFamily === isIP(plain)) {
      hintMatched = sourceGroup(plain) === registration.hintGroup;
      if (!hintMatched) {
        this.#counters.addressDiffers++;
        if (!registration.mismatchReported) {
          registration.mismatchReported = true;
          this.#onEvent({
            type: 'address-differs',
            streamId: registration.streamId,
            tuple: tupleText(plain, rinfo.port),
          });
        }
      }
    }
    const created = this.#pin(registration, plain, rinfo);
    registration.pinnedOnce = true;
    this.#onEvent({
      type: 'pinned',
      streamId: registration.streamId,
      tuple: tupleText(plain, rinfo.port),
      hintMatched,
    });
    this.#toWorker(created, message);
  }

  #fromPinned(pin, message) {
    const registration = pin.registration;
    const kind = message.length ? datagramClass(message[0]) : null;
    if (!kind) return this.#drop('class');
    if (kind === 'stun') {
      const parsed = parseStun(message);
      if (!parsed) return this.#drop('malformed');
      if (parsed.type === TYPES.bindingRequest) {
        if (parsed.username !== `${registration.ufrag}:${registration.clientUfrag}`)
          return this.#drop(
            this.#byUfrag.has(receiverUfrag(parsed)) ? 'cross-registration' : 'unknown-ufrag',
          );
        if (!verifyIntegrity(message, parsed, registration.pwd)) return this.#drop('bad-integrity');
      } else if (!verifyIntegrity(message, parsed, registration.clientPwd))
        // A response to a check the worker sent: keyed with the client's password.
        return this.#drop('bad-integrity');
    }
    this.#toWorker(pin, message);
  }

  #pin(registration, plain, rinfo) {
    const pin = {
      key: `${plain}|${rinfo.port}`,
      sendAddress: rinfo.address,
      port: rinfo.port,
      registration,
      lastSeen: this.#now(),
      ready: false,
      queue: [],
      socket: this.#createSocket({
        type: 'udp4',
        recvBufferSize: this.#limits.socketBufferBytes,
        sendBufferSize: this.#limits.socketBufferBytes,
      }),
    };
    pin.socket.on('error', () => {});
    pin.socket.on('message', (message, from) => {
      if (plainAddress(from.address) !== '127.0.0.1' || from.port !== registration.workerPort)
        return this.#drop('loopback-source');
      if (!this.#pins.has(pin.key)) return;
      pin.lastSeen = this.#now();
      this.#counters.forwarded.toClient.packets++;
      this.#counters.forwarded.toClient.bytes += message.length;
      this.#public?.send(message, pin.port, pin.sendAddress);
    });
    pin.socket.bind(0, '127.0.0.1', () => {
      pin.ready = true;
      for (const queued of pin.queue.splice(0)) this.#toWorker(pin, queued);
    });
    registration.pins.add(pin);
    this.#pins.set(pin.key, pin);
    return pin;
  }

  #toWorker(pin, message) {
    pin.lastSeen = this.#now();
    if (!pin.ready) {
      if (pin.queue.length < this.#limits.queuedPerPin) pin.queue.push(message);
      return;
    }
    this.#counters.forwarded.toWorker.packets++;
    this.#counters.forwarded.toWorker.bytes += message.length;
    pin.socket.send(message, pin.registration.workerPort, '127.0.0.1');
  }

  #unpin(pin, reason) {
    if (!this.#pins.delete(pin.key)) return;
    pin.registration.pins.delete(pin);
    pin.queue.length = 0;
    try {
      pin.socket.close();
    } catch {
      // Already closed.
    }
    const [plain] = pin.key.split('|');
    this.#onEvent({
      type: 'unpinned',
      streamId: pin.registration.streamId,
      tuple: tupleText(plain, pin.port),
      reason,
    });
  }

  // Two lanes: senders whose address matches a registration's hint, and everyone else.
  // Forged-source floods can only exhaust the second.
  #budget(plain) {
    const now = this.#now();
    const window = this.#window;
    if (now - window.start >= 1000) {
      window.start = now;
      window.total = 0;
      window.perSource.clear();
      window.perRegistration.clear();
    }
    const group = sourceGroup(plain);
    const hinted = this.#byHint.get(group);
    if (hinted)
      for (const registration of hinted) {
        const used = window.perRegistration.get(registration) ?? 0;
        if (used < this.#limits.hintLanePerSecond) {
          window.perRegistration.set(registration, used + 1);
          return true;
        }
      }
    if (window.total >= this.#limits.strangerTotal) return false;
    const used = window.perSource.get(group) ?? 0;
    if (used >= this.#limits.strangerPerSource) return false;
    window.perSource.set(group, used + 1);
    window.total++;
    return true;
  }

  #drop(reason) {
    this.#counters.dropped[reason]++;
  }

  #index(map, key, value) {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(value);
  }

  #unindex(map, key, value) {
    const set = map.get(key);
    if (!set) return;
    set.delete(value);
    if (!set.size) map.delete(key);
  }
}
