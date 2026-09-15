import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultStreamPolicy } from '../src/stream-policy.mjs';
import {
  SessionNumbers,
  resolveDisplay,
  resolveProfile,
  resolveSession,
} from '../src/cli/resolve.mjs';
import { UsageError } from '../src/cli/usage-error.mjs';
import { MAIN, SIDE, displayRows } from './fixtures/cli-displays.mjs';

const usage = (error) => error instanceof UsageError;
const failure = (pattern) => (error) =>
  !(error instanceof UsageError) && pattern.test(error.message);

test('displays resolve by number, #number or unique ID prefix', () => {
  const displays = displayRows();
  assert.equal(resolveDisplay(displays, '2').id, SIDE);
  assert.equal(resolveDisplay(displays, '#1').id, MAIN);
  assert.equal(resolveDisplay(displays, 'BBBBBBBB').id, SIDE);
  assert.throws(
    () => resolveDisplay(displays, '9'),
    failure(/^There is no display 9\. Use displays to list them\.$/),
  );
  assert.throws(
    () => resolveDisplay(displays, 'dddddddd'),
    failure(/No display ID starts with dddddddd/),
  );
  assert.throws(() => resolveDisplay(displays, 'left'), usage);
  assert.throws(() => resolveDisplay(displays, 'abc'), usage);
  const similar = [
    { ...displays[0], id: `abcdefab${'0'.repeat(56)}` },
    { ...displays[1], id: `abcdefab${'1'.repeat(56)}` },
  ];
  assert.throws(
    () => resolveDisplay(similar, 'abcdefab'),
    failure(/matches more than one display/),
  );
});

test('profiles resolve by exact ID or unique case-insensitive name', () => {
  const { profiles } = defaultStreamPolicy();
  assert.equal(resolveProfile(profiles, 'balanced').id, 'balanced');
  assert.equal(resolveProfile(profiles, 'IPHONE 720P').id, 'iphone-720p-test');
  const twins = [...profiles, { ...profiles[1], id: 'other' }];
  assert.throws(() => resolveProfile(twins, 'MOBILE'), {
    message: 'More than one profile is named "MOBILE"; use its ID.',
  });
  assert.throws(() => resolveProfile(profiles, 'nope'), {
    message: 'No profile matches "nope". Use profiles to list them.',
  });
});

test("profile selector ambiguous between one profile's ID and another's name is an error", () => {
  const { profiles } = defaultStreamPolicy();
  const twins = [
    { ...profiles[0], id: 'office', name: 'Old office' },
    { ...profiles[1], id: 'office-2', name: 'Office' },
  ];
  assert.throws(() => resolveProfile(twins, 'office'), {
    message:
      '"office" matches the ID of "Old office" and the name of another profile; ' +
      'use that profile\'s ID (office-2) or "Old office" by name.',
  });
  // ID and name refer to the same profile: unchanged, no ambiguity.
  const selfNamed = [{ ...profiles[0], id: 'office', name: 'office' }, profiles[1]];
  assert.equal(resolveProfile(selfNamed, 'office').id, 'office');
  // Only the ID matches (no colliding name): unchanged.
  assert.equal(resolveProfile(twins, 'office-2').id, 'office-2');
});

test('sessions resolve by console number or stream ID without echoing session IDs', () => {
  const numbers = new SessionNumbers();
  const rows = [
    { id: '11111111-1111-4111-8111-111111111111', streams: [{ id: 'stream-a' }] },
    { id: '22222222-2222-4222-8222-222222222222', streams: [] },
  ];
  assert.equal(resolveSession(rows, numbers, '#1'), rows[0]);
  assert.equal(resolveSession(rows, numbers, '2'), rows[1]);
  assert.equal(resolveSession(rows, numbers, 'stream-a'), rows[0]);
  numbers.prune(new Set([rows[1].id]));
  const third = { id: '33333333-3333-4333-8333-333333333333', streams: [] };
  assert.equal(resolveSession([rows[1], third], numbers, '#3'), third);
  assert.equal(numbers.number(rows[1].id), 2);
  assert.throws(
    () => resolveSession([rows[1], third], numbers, '#1'),
    (error) =>
      error.message === 'No connected device matches #1. Use sessions to list them.' &&
      !error.message.includes(rows[0].id),
  );
});
