import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { eligibleAdapter, subnetOf } from './local-session-scope.mjs';

// The owner's confirmation of each network before the server binds to it (decision Q2 of the
// macOS design). macOS has no Private network profile, so the app asks the first time it sees
// a network, and the answer is remembered. Only a server started with `--confirm-networks`
// (the macOS app) uses this; the command-line server never asks.
//
// A network is recognised by its subnets and its router's hardware address: reading the Wi-Fi
// name would need Location Services. Every address on one interface belongs to one network,
// so an IPv4 network with a unique-local IPv6 prefix is one question, not two. Until the owner
// allows a network its rows are reported with a Public profile, which the shared scope
// (local-session-scope.mjs) never admits.

const SCHEMA_VERSION = 1;
// Oldest decisions are forgotten first; a forgotten network is simply asked about again.
export const MAX_KNOWN_NETWORKS = 256;
const ID = /^[0-9a-f]{16}$/;

function invalid() {
  return new Error('Invalid known networks file');
}

function validate(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    value.schemaVersion !== SCHEMA_VERSION ||
    !Array.isArray(value.networks) ||
    value.networks.length > MAX_KNOWN_NETWORKS ||
    Object.keys(value).some((key) => !['schemaVersion', 'networks'].includes(key))
  )
    throw invalid();
  const ids = new Set();
  for (const row of value.networks) {
    if (
      !row ||
      typeof row !== 'object' ||
      !ID.test(row.id) ||
      ids.has(row.id) ||
      typeof row.allow !== 'boolean' ||
      !Array.isArray(row.subnets) ||
      !row.subnets.length ||
      row.subnets.length > 16 ||
      row.subnets.some((subnet) => typeof subnet !== 'string' || subnet.length > 64) ||
      (row.router !== null && (typeof row.router !== 'string' || row.router.length > 17)) ||
      !Number.isSafeInteger(row.decidedAt) ||
      Object.keys(row).some(
        (key) => !['id', 'subnets', 'router', 'allow', 'decidedAt'].includes(key),
      )
    )
      throw invalid();
    ids.add(row.id);
  }
  return value;
}

async function read(filename) {
  try {
    return validate(JSON.parse(await readFile(filename, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: SCHEMA_VERSION, networks: [] };
    if (error instanceof SyntaxError) throw invalid();
    throw error;
  }
}

// The identity of the network each interface is on, from the rows that could be eligible.
export function networksOf(rows) {
  const byInterface = new Map();
  for (const row of rows) {
    const subnet = eligibleAdapter(row) ? subnetOf(row.address, row.prefixLength) : null;
    if (!subnet) continue;
    const key = row.interface ?? row.address;
    const entry = byInterface.get(key) ?? {
      interface: row.interface ?? null,
      kind: row.kind,
      router: row.router?.hardwareAddress ?? null,
      ipv4: new Set(),
      ipv6: new Set(),
    };
    entry[subnet.includes(':') ? 'ipv6' : 'ipv4'].add(subnet);
    byInterface.set(key, entry);
  }
  const networks = new Map();
  for (const [key, entry] of byInterface) {
    // IPv4 identifies the network when there is any; an IPv6-only link uses its prefixes.
    const subnets = [...(entry.ipv4.size ? entry.ipv4 : entry.ipv6)].sort();
    const id = createHash('sha256')
      .update(`${subnets.join(',')}|${entry.router ?? ''}`)
      .digest('hex')
      .slice(0, 16);
    networks.set(key, {
      id,
      subnets,
      router: entry.router,
      interface: entry.interface,
      kind: entry.kind,
    });
  }
  return networks;
}

export class KnownNetworks {
  #filename;
  #value;
  #now;
  #queue = Promise.resolve();
  // Networks seen and not decided yet, by id, as the status line reports them.
  #pending = new Map();

  constructor(filename, value, { now = () => Date.now() } = {}) {
    this.#filename = filename;
    this.#value = value;
    this.#now = now;
  }

  static async open(filename, options) {
    return new KnownNetworks(filename, await read(filename), options);
  }

  // The rows with every row on a network the owner has not allowed marked Public. Networks
  // seen for the first time become pending; one that is no longer present stops being.
  apply(rows) {
    const decisions = new Map(this.#value.networks.map((row) => [row.id, row.allow]));
    const networks = networksOf(rows);
    const pending = new Map();
    for (const network of networks.values())
      if (!decisions.has(network.id))
        pending.set(network.id, {
          ...network,
          firstSeenAt: this.#pending.get(network.id)?.firstSeenAt ?? this.#now(),
        });
    this.#pending = pending;
    return rows.map((row) => {
      const network = networks.get(row.interface ?? row.address);
      return network && decisions.get(network.id) === true ? row : { ...row, profile: 'Public' };
    });
  }

  pending() {
    return [...this.#pending.values()].map((row) => ({ ...row, subnets: [...row.subnets] }));
  }

  known() {
    return structuredClone(this.#value.networks);
  }

  // Records the owner's answer for a pending network, or changes an earlier one.
  decide(id, allow) {
    const operation = this.#queue.then(async () => {
      if (typeof id !== 'string' || !ID.test(id)) throw new Error('Unknown network');
      if (typeof allow !== 'boolean') throw new Error('Invalid network decision');
      const seen = this.#pending.get(id) ?? this.#value.networks.find((row) => row.id === id);
      if (!seen) throw new Error('Unknown network');
      const row = {
        id,
        subnets: [...seen.subnets],
        router: seen.router ?? null,
        allow,
        decidedAt: this.#now(),
      };
      const networks = [...this.#value.networks.filter((known) => known.id !== id), row]
        .sort((a, b) => a.decidedAt - b.decidedAt)
        .slice(-MAX_KNOWN_NETWORKS);
      const next = validate({ schemaVersion: SCHEMA_VERSION, networks });
      await this.#write(next);
      this.#value = next;
      this.#pending.delete(id);
      return structuredClone(row);
    });
    this.#queue = operation.catch(() => {});
    return operation;
  }

  async #write(value) {
    await mkdir(dirname(this.#filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.#filename}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(JSON.stringify(value));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.#filename);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
}
