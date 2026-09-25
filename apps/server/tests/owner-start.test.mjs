import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { waitForOwner } from '../src/owner-start.mjs';

test('owner gate accepts Windows StreamWriter CRLF approval', async () => {
  const input = new PassThrough();
  const ready = waitForOwner(input);
  input.write('{"type":"start"}\r\n');
  assert.equal(await ready, 'local');
});

test('owner gate returns the requested sharing mode and nothing else', async () => {
  for (const [line, mode] of [
    ['{"type":"start","sharing":"local"}', 'local'],
    ['{"type":"start","sharing":"remote"}', 'remote'],
  ]) {
    const input = new PassThrough();
    const ready = waitForOwner(input);
    input.write(line + '\n');
    assert.equal(await ready, mode);
  }
  for (const line of [
    '{"type":"start","sharing":"internet"}',
    '{"type":"start", "sharing":"remote"}',
    '{"sharing":"remote","type":"start"}',
  ]) {
    const input = new PassThrough();
    const ready = waitForOwner(input);
    input.write(line + '\n');
    await assert.rejects(ready, /Invalid desktop owner approval/);
  }
});

test('owner gate waits for approval and preserves later commands', async () => {
  const input = new PassThrough();
  let approved = false;
  const ready = waitForOwner(input).then(() => {
    approved = true;
  });
  input.write('{"type":');
  await new Promise(setImmediate);
  assert.equal(approved, false);
  input.write('"start"}\n{"type":"stop"}\n');
  await ready;
  assert.equal(input.read().toString(), '{"type":"stop"}\n');
});

test('owner gate rejects EOF or malformed approval without starting capture', async () => {
  for (const value of ['', 'no\n', 'x'.repeat(65)]) {
    const input = new PassThrough();
    const ready = waitForOwner(input);
    input.end(value);
    await assert.rejects(ready, /owner/i);
  }
});
