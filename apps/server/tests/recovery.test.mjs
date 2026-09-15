import test from 'node:test';
import assert from 'node:assert/strict';
import { Recovery } from '../src/recovery.mjs';
test('recovery ignores first samples, resets, missing counters and NACK-only loss', () => {
  const r = new Recovery();
  assert.equal(r.observe({ pliCount: 10 }, 0), false);
  assert.equal(r.observe({ pliCount: 0, nackCount: 999 }, 4000), false);
  assert.equal(r.observe({}, 8000), false);
  assert.equal(r.observe({ pliCount: 8 }, 12000), false);
  assert.equal(r.observe({ pliCount: 9 }, 16000), true);
});
test('PLI/FIR increases trigger bounded requests without repeatedly acting on old counters', () => {
  const r = new Recovery();
  r.observe({ pliCount: 0, firCount: 0 }, 0);
  assert.equal(r.observe({ pliCount: 1, firCount: 0 }, 1000), true);
  assert.equal(r.observe({ pliCount: 2, firCount: 0 }, 2000), false);
  assert.equal(r.observe({ pliCount: 2, firCount: 0 }, 6000), false);
  assert.equal(r.observe({ pliCount: 2, firCount: 1 }, 7000), true);
});
