import test from 'node:test';
import assert from 'node:assert/strict';
import { effectivePermission } from '../src/approved-client-permission.mjs';

test('current approved credential permission resolves conservatively', () => {
  assert.equal(effectivePermission(null, 'available'), 'view-only');
  assert.equal(effectivePermission({ permission: 'default' }, 'approval'), 'approval');
  assert.equal(effectivePermission({ permission: 'view-only' }, 'available'), 'view-only');
  assert.equal(effectivePermission({ permission: 'available' }, 'approval'), 'available');
});
