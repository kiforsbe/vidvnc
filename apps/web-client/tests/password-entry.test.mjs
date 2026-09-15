import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPasswordEntry,
  normalizePassword,
  formatSegmentedPasswordEntry,
} from '../src/password-entry.js';

test('accepts lowercase, optional dash and surrounding pasted whitespace', () => {
  for (const text of ['abcdefgh', 'abcd-efgh', ' ABCD-EFGH\n'])
    assert.equal(normalizePassword(text), 'ABCD-EFGH');
  for (const text of ['ABCDEFGHX', 'ABCD!EFGH', 'abc', null])
    assert.equal(normalizePassword(text), null);
});

test('segmented entry preserves selection and never silently truncates invalid secrets', () => {
  assert.deepEqual(formatSegmentedPasswordEntry(' abcd-efgh ', 3, 8), {
    value: 'ABCD-EFGH',
    start: 2,
    end: 7,
  });
  assert.deepEqual(formatSegmentedPasswordEntry('ABCDEFGHX', 9, 9), {
    value: 'ABCD-EFGHX',
    start: 10,
    end: 10,
  });
  assert.deepEqual(formatSegmentedPasswordEntry('AB!CD', 2, 3), {
    value: 'AB!CD',
    start: 2,
    end: 3,
  });
});
test('formats only after entering the second group and preserves the editing caret', () => {
  assert.deepEqual(formatPasswordEntry('abcd', 4), { value: 'ABCD', caret: 4 });
  assert.deepEqual(formatPasswordEntry('abcde', 5), { value: 'ABCD-E', caret: 6 });
  assert.deepEqual(formatPasswordEntry('ABCD-EFGH', 3), { value: 'ABCD-EFGH', caret: 3 });
  assert.deepEqual(formatPasswordEntry('ABCEFGH', 3), { value: 'ABCE-FGH', caret: 3 });
});
