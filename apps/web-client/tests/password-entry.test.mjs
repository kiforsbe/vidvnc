import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('accepts reduced-ambiguity letters and digits without changing forbidden symbols', () => {
  assert.equal(normalizePassword('2a3b-4c5d'), '2A3B-4C5D');
  for (const value of ['0ABC-DEFG', '1ABC-DEFG', 'IABC-DEFG', 'LABC-DEFG', 'OABC-DEFG'])
    assert.equal(normalizePassword(value), null, value);
  assert.deepEqual(formatPasswordEntry('2a3b4c5d', 8), { value: '2A3B-4C5D', caret: 9 });
  assert.deepEqual(formatPasswordEntry('2A0B-4C5D', 9), { value: '2A0B-4C5D', caret: 9 });
});

test('segmented entry preserves selection and keeps eligible digits', () => {
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
    value: 'AB12-CDEF',
    start: 9,
    end: 9,
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

test('browser admission uses one key-start request and never resubmits the short code during registration', async () => {
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(app, /api\('key-start',\s*\{\s*key:/);
  assert.doesNotMatch(app, /api\('(connection-key|connect)'/);
  assert.match(app, /registrationTicket:\s*registrationTicket/);
  assert.doesNotMatch(app, /registrationKey/);
});

test('anonymous page and script contain only admission UI, not the viewer', async () => {
  const page = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /id="(?:viewer|video|audio|streamProfile|qualityPanel)"/);
  assert.doesNotMatch(page, /<video\b|<audio\b|\/viewer\/app\.js/i);
  assert.doesNotMatch(app, /\/api\/(?:profiles|offer|stream-[a-z-]+)/);
  assert.doesNotMatch(app, /api\('(profiles|offer|reconnect|telemetry|heartbeat)'/);
  assert.doesNotMatch(app, /RTCPeerConnection|createDataChannel|type:\s*'key'/);
  assert.doesNotMatch(
    app,
    /from '\.\/(?:receiver-stats|stream-subscriptions|codec-preferences|profile-labels)\.js'/,
  );
  assert.match(app, /info\.publicName/);
  assert.match(app, /import\('\/viewer\/app\.js'\)/);
});
