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

test('segmented entry preserves selection and discards characters other than letters', () => {
  assert.deepEqual(formatSegmentedPasswordEntry(' abcd-efgh ', 3, 8), {
    value: 'ABCD-EFGH',
    start: 2,
    end: 7,
  });
  assert.deepEqual(formatSegmentedPasswordEntry('ABCDEFGHX', 9, 9), {
    value: 'ABCD-EFGH',
    start: 9,
    end: 9,
  });
  assert.deepEqual(formatSegmentedPasswordEntry('AB!CD', 2, 3), {
    value: 'ABCD',
    start: 2,
    end: 2,
  });
  assert.deepEqual(formatSegmentedPasswordEntry('AB12CDÅE_FG', 11, 11), {
    value: 'ABCD-EFG',
    start: 8,
    end: 8,
  });
});
test('formats only after entering the second group and preserves the editing caret', () => {
  assert.deepEqual(formatPasswordEntry('abcd', 4), { value: 'ABCD', caret: 4 });
  assert.deepEqual(formatPasswordEntry('abcde', 5), { value: 'ABCD-E', caret: 6 });
  assert.deepEqual(formatPasswordEntry('ABCD-EFGH', 3), { value: 'ABCD-EFGH', caret: 3 });
  assert.deepEqual(formatPasswordEntry('ABCEFGH', 3), { value: 'ABCE-FGH', caret: 3 });
});
test('caps entry at eight letters without pushing out existing letters', () => {
  // Typing into a full password is ignored wherever the caret is.
  assert.deepEqual(formatPasswordEntry('ABXCD-EFGH', 3), { value: 'ABCD-EFGH', caret: 2 });
  assert.deepEqual(formatPasswordEntry('ABCD-EFGHX', 10), { value: 'ABCD-EFGH', caret: 9 });
  // Over-long pastes are cut at the end of the pasted text; separators and
  // surrounding whitespace do not count towards the limit.
  assert.deepEqual(formatPasswordEntry('ABCDEFGHIJKL', 12), { value: 'ABCD-EFGH', caret: 9 });
  assert.deepEqual(formatPasswordEntry('ABWXYZQCD', 7), { value: 'ABWX-YZCD', caret: 7 });
  assert.deepEqual(formatPasswordEntry(' abcd-efgh ', 11), { value: 'ABCD-EFGH', caret: 9 });
  assert.deepEqual(formatSegmentedPasswordEntry('AB!CDEFGHIJ', 11, 11), {
    value: 'ABCD-EFGH',
    start: 9,
    end: 9,
  });
});
