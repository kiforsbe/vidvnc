import test from 'node:test';
import assert from 'node:assert/strict';
import { DiagnosticsCapabilities } from '../src/diagnostics-capabilities.mjs';

test('owner diagnostics capabilities are random, hashed, bounded and expire', () => {
  let now = 1_000;
  const caps = new DiagnosticsCapabilities({ clock: () => now });
  const issued = Array.from({ length: 5 }, () => caps.issue());
  assert.match(issued[0].token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(new Set(issued.map((row) => row.token)).size, 5);
  assert.equal(issued[0].expiresAt, 901_000);
  assert.equal(caps.allows(issued[0].token), false);
  assert.equal(caps.allows(issued[4].token), true);
  assert.equal(caps.allows(issued[4].token), true);
  assert.equal(caps.allows('x'.repeat(43)), false);
  assert.equal(caps.allows('not-a-capability'), false);
  assert.equal(JSON.stringify(caps).includes(issued[4].token), false);
  now += 899_999;
  assert.equal(caps.allows(issued[4].token), true);
  now++;
  assert.equal(caps.allows(issued[4].token), false);
  now -= 500_000;
  assert.equal(caps.allows(issued[4].token), false);
});

test('issuer never permits more than four outstanding capabilities', () => {
  assert.throws(() => new DiagnosticsCapabilities({ maxOutstanding: 5 }), /outstanding/i);
  assert.throws(() => new DiagnosticsCapabilities({ ttlMs: 900_001 }), /lifetime|ttl/i);
});
