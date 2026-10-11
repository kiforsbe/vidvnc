// The macOS host against the owner protocol contract
// (apps/server/tests/fixtures/owner-protocol/): every command its Swift sources send is in
// the contract, and the stand-in server its UI and process-tree tests use answers in the
// contract's shapes. The host's own decoding of every example is checked by its Swift unit
// tests (VidVNCTests/OwnerMessagesTests.swift).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { shapeMismatches } from '../../server/tests/fixtures/owner-protocol/shape.mjs';

const fixtures = new URL('../../server/tests/fixtures/owner-protocol/', import.meta.url);
const load = (name) => JSON.parse(readFileSync(new URL(name, fixtures), 'utf8'));
const commands = load('commands.json');
const replies = load('replies.json');
const lines = load('lines.json');

// `"type": "access-set"` in a Swift dictionary, or `{"type":"stop"}` in a raw string.
function swiftCommandTypes(directory) {
  const types = new Set();
  const pattern = /"type"\s*:\s*"([a-z][a-z-]+)"/g;
  for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.swift')) continue;
    const source = readFileSync(`${entry.parentPath}/${entry.name}`, 'utf8');
    for (const [, type] of source.matchAll(pattern)) types.add(type);
  }
  return types;
}

test('every command the macOS host sends is in the contract', () => {
  const sent = swiftCommandTypes(fileURLToPath(new URL('../VidVNC/', import.meta.url)));
  assert.ok(sent.has('policy-set') && sent.has('network-confirm'), 'host scan found commands');
  for (const type of sent)
    if (type !== 'start')
      assert.ok(
        Object.hasOwn(commands, type),
        `${type} is sent by the host but not in the contract`,
      );
});

test('the macOS stand-in server answers in the contract shapes', async (t) => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('stand-in-server.mjs', import.meta.url))],
    { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, VIDVNC_STAND_IN_NETWORKS: '1' } },
  );
  t.after(() => child.kill());
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => JSON.parse((await output.next()).value);
  child.stdin.write('{"type":"start","sharing":"local"}\n');

  const ready = await next();
  assert.deepEqual(shapeMismatches(lines.ready[0], ready), []);
  const status = await next();
  assert.deepEqual(shapeMismatches(lines.status[1], status), []);
  const clients = await next();
  assert.deepEqual(shapeMismatches(lines.clients[0], clients), []);

  for (const [type, { command, replies: expected }] of Object.entries(commands)) {
    if (type === 'stop' || type === 'disconnect') continue;
    child.stdin.write(`${JSON.stringify(command)}\n`);
    let reply = await next();
    // Status and clients lines keep coming once a second; skip to the reply.
    while (reply.type === 'status' || reply.type === 'clients') reply = await next();
    assert.equal(reply.type, expected[0], type);
    const matches = replies[reply.type].some(
      (example) => shapeMismatches(example, reply).length === 0,
    );
    assert.ok(matches, `${type}: ${JSON.stringify(reply)} matches no contract example`);
  }
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.stdin.write('{"type":"stop"}\n');
  assert.equal(await exited, 0);
});

test('the stand-in refuses anything but an approval line, as the server does', async () => {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('stand-in-server.mjs', import.meta.url))],
    { stdio: ['pipe', 'ignore', 'ignore'] },
  );
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.stdin.end('{ "type": "start" }\n');
  assert.equal(await exited, 2);
});
