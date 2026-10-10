// The owner protocol contract (docs/ARCHITECTURE.md, "Owner protocol"): the server's real
// replies and lines must match the examples in fixtures/owner-protocol/, every command a
// host sends must be in them, and the Windows host's test fixture server
// (apps/windows-host/tests/Navigation/owner-fixture.mjs) must answer in the same shapes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { waitForOwner } from '../src/owner-start.mjs';
import { OWNER_COMMAND_MAX_BYTES } from '../src/owner-commands.mjs';
import { ownerServer } from './fixtures/owner-protocol/server.mjs';
import { matchVariant, shapeMismatches } from './fixtures/owner-protocol/shape.mjs';

const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`./fixtures/owner-protocol/${name}.json`, import.meta.url)));
const start = fixture('start');
const commands = fixture('commands');
const replies = fixture('replies');
const lines = fixture('lines');

// Every example a reply or line can take: replies.json by reply type, lines.json by line type.
const examples = (type) => replies[type] ?? lines[type];

async function server(t, options) {
  const owner = await ownerServer(options);
  t.after(() => owner.close());
  return owner;
}

// Records which examples the real server produced, so no example outlives the code.
const produced = new Map();
function check(message) {
  const variants = examples(message.type);
  assert.ok(variants, `${message.type} is not in the contract`);
  const index = matchVariant(variants, message);
  produced.set(`${message.type}#${index}`, true);
}

test('the approval line is exactly one of the contract start lines', async () => {
  for (const [line, mode] of Object.entries(start.accepted)) {
    const input = new PassThrough();
    const waiting = waitForOwner(input);
    input.write(`${line}\n`);
    assert.equal(await waiting, mode);
  }
  for (const line of start.rejected) {
    const input = new PassThrough();
    const waiting = waitForOwner(input);
    input.write(`${line}\n`);
    await assert.rejects(waiting, /Invalid desktop owner approval/);
  }
});

test('the server answers every contract command in the contract shapes', async (t) => {
  // With a generated certificate, so tls-regenerate succeeds too.
  const owner = await server(t, { tlsMode: 'auto' });
  const { sessionId, streamId, pendingId, approvedId } = await owner.populate();
  // The examples carry placeholder ids; the server only knows the ones it issued.
  const ids = {
    'client-request-command': { id: pendingId },
    'approved-client-command': { id: approvedId },
    'session-command': { sessionId, streamId },
  };
  for (const [type, { command, replies: expected }] of Object.entries(commands)) {
    if (type === 'stop' || type === 'disconnect') continue;
    const sent = { ...command, ...ids[type] };
    if (type === 'policy-set') sent.policy = { ...command.policy, revision: sent.revision };
    const got = await owner.send(sent, expected.length);
    assert.deepEqual(
      got.map((line) => line.type),
      expected,
      type,
    );
    for (const line of got) {
      check(line);
      if ('requestId' in line) assert.equal(line.requestId, command.requestId);
      assert.equal(line.ok ?? true, true, `${type}: ${line.error ?? line.reason}`);
    }
  }
});

test('failures and the optional reply fields match the contract', async (t) => {
  const owner = await server(t);
  const { sessionId } = await owner.populate();
  const requestId = 'failure';
  const failures = [
    { type: 'connection-once-create', alphabet: 'emoji', requestId },
    { type: 'client-setup-create', alphabet: 'emoji', requestId },
    { type: 'session-password-rotate', alphabet: 'emoji', requestId },
    { type: 'client-request-command', action: 'approve', id: 'unknown', requestId },
    { type: 'access-set', requestId, revision: 99, maxSessions: 2 },
    { type: 'session-command', requestId, action: 'revoke', sessionId: 'unknown' },
    { type: 'policy-set', requestId, revision: 99, policy: {}, disconnect: false },
    { type: 'tls-regenerate' },
  ];
  for (const command of failures) {
    const [reply] = await owner.send(command);
    assert.equal(reply.ok, false, command.type);
    check(reply);
  }
  // Changing the connection method issues a new session password with the reply.
  const [changed] = await owner.send({
    type: 'access-set',
    requestId,
    revision: 0,
    connectionMode: 'one-time-keys',
  });
  assert.equal(typeof changed.sessionKey, 'string');
  check(changed);
  const [disconnected] = await owner.send({ type: 'ordinary-sessions-disconnect', requestId });
  assert.equal(disconnected.disconnected, 1);
  check(disconnected);
  // No reply: the session simply ends.
  await owner.send({ type: 'disconnect', id: sessionId }, 0);
  assert.equal(owner.lines.length, failures.length + 2);
});

test('a provided certificate is never regenerated, and a generated one is', async (t) => {
  const provided = await server(t, { tlsMode: 'provided' });
  const [refused] = await provided.send(commands['tls-regenerate'].command);
  assert.equal(refused.ok, false);
  check(refused);
  const generated = await server(t, { tlsMode: 'auto' });
  const [done] = await generated.send(commands['tls-regenerate'].command);
  assert.equal(done.ok, true);
  check(done);
});

test('the ready, status, clients and displays lines match the contract', async (t) => {
  const owner = await server(t);
  await owner.populate();
  check(owner.ready());
  check(owner.ready('Sharing started on the local network only.'));
  for (const line of owner.status()) check(line);
  check(owner.displays());
});

test('stop, malformed, unknown and oversized lines get no reply', async (t) => {
  const owner = await server(t);
  for (const line of [
    'not json',
    'null',
    '{"type":"unknown","requestId":"x"}',
    '{"type":"access-set"}',
    JSON.stringify({ type: 'access-set', requestId: 'x'.repeat(65), revision: 0 }),
    JSON.stringify({
      type: 'diagnostics-capability-create',
      requestId: 'x',
      padding: 'x'.repeat(OWNER_COMMAND_MAX_BYTES),
    }),
  ])
    await owner.send(line, 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(owner.lines, []);
  await owner.send(' {"type":"stop"}', 0);
  assert.equal(owner.stopped(), false);
  await owner.send(JSON.stringify(commands.stop.command), 0);
  assert.equal(owner.stopped(), true);
  // Nothing is answered once stopping, so a host never waits on a reply to a dying server.
  await owner.send(commands['diagnostics-capability-create'].command, 0);
  assert.deepEqual(owner.lines, []);
});

test('a renamed, missing, extra or retyped field breaks the contract', async (t) => {
  const owner = await server(t);
  await owner.populate();
  const [status] = owner.status();
  const [example] = lines.status;
  assert.deepEqual(shapeMismatches(example, status), []);
  const { relay, ...withoutRelay } = status;
  assert.match(shapeMismatches(example, withoutRelay).join(), /\$\.relay: missing/);
  assert.match(
    shapeMismatches(example, { ...status, relays: relay }).join(),
    /\$\.relays: not in the contract/,
  );
  const retyped = structuredClone(status);
  retyped.sessions[0].streams[0].width = '1280';
  assert.match(
    shapeMismatches(example, retyped).join(),
    /\$\.sessions\[0\]\.streams\[0\]\.width: expected number, got string/,
  );
  assert.throws(() => matchVariant(replies['session-result'], { type: 'session-result' }));
});

// Runs last (node:test runs a file's tests in order): every example was produced above.
test('every example in the contract is something the server really sends', () => {
  const expected = [
    ...Object.entries(replies).flatMap(([type, list]) => list.map((_, i) => `${type}#${i}`)),
    ...Object.entries(lines).flatMap(([type, list]) => list.map((_, i) => `${type}#${i}`)),
  ];
  assert.deepEqual(
    expected.filter((key) => !produced.has(key)),
    [],
  );
});

// Command types named in a host's sources: `["type"] = "x"`, `type = "x"`, `\"type\":\"x`
// and `SendClientCommand("x"`.
function hostCommandTypes(directory, extension) {
  const types = new Set();
  const pattern =
    /(?:\["type"\]\s*=\s*"|\btype\s*=\s*"|\\"type\\":\\"|SendClientCommand\(")([a-z][a-z-]+)/g;
  for (const name of readdirSync(directory)) {
    if (!name.endsWith(extension)) continue;
    const source = readFileSync(new URL(name, directory), 'utf8');
    for (const [, type] of source.matchAll(pattern)) types.add(type);
  }
  return types;
}

test('every command the Windows host sends is in the contract', () => {
  const sent = hostCommandTypes(new URL('../../windows-host/', import.meta.url), '.cs');
  assert.ok(sent.has('policy-set') && sent.has('tls-regenerate'), 'host scan found commands');
  for (const type of sent)
    if (type !== 'start')
      assert.ok(
        Object.hasOwn(commands, type),
        `${type} is sent by the host but not in the contract`,
      );
});

test('the Windows host test fixture answers in the contract shapes', async (t) => {
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL('../../windows-host/tests/Navigation/owner-fixture.mjs', import.meta.url),
      ),
    ],
    { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true },
  );
  t.after(() => child.kill());
  const output = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  for (const [type, { command, replies: expected }] of Object.entries(commands)) {
    if (type === 'stop' || type === 'disconnect') continue;
    child.stdin.write(`${JSON.stringify(command)}\n`);
    // The fixture answers each command with its first reply only, plus what it received.
    const { value } = await output.next();
    const { received, ...reply } = JSON.parse(value);
    assert.equal(reply.type, expected[0], type);
    assert.equal(received?.type ?? type, type);
    const problems = examples(reply.type)
      .map((example) => shapeMismatches(example, reply))
      .find((list) => list.length === 0);
    assert.ok(problems, `${type}: ${JSON.stringify(reply)} matches no contract example`);
  }
  child.stdin.end();
});
