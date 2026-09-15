import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_LINE, tokenize } from '../src/cli/tokenize.mjs';
import { UsageError } from '../src/cli/usage-error.mjs';

test('tokenize splits on whitespace and keeps quoted text together', () => {
  assert.deepEqual(tokenize('  profile add "Office desk"  --fps 60 '), [
    'profile',
    'add',
    'Office desk',
    '--fps',
    '60',
  ]);
  assert.deepEqual(tokenize('profile edit x --description ""'), [
    'profile',
    'edit',
    'x',
    '--description',
    '',
  ]);
  assert.deepEqual(tokenize('name "say \\"hi\\" \\\\ ok"'), ['name', 'say "hi" \\ ok']);
  assert.deepEqual(tokenize('path C:\\temp'), ['path', 'C:\\temp']);
  assert.deepEqual(tokenize('a"b c"d'), ['ab cd']);
  assert.deepEqual(tokenize('\t'), []);
});

test('tokenize rejects unterminated quotes and overlong lines as usage errors', () => {
  assert.throws(
    () => tokenize('profile add "Office'),
    (error) => error instanceof UsageError && error.message === 'Unterminated quote.',
  );
  assert.throws(
    () => tokenize('x'.repeat(MAX_LINE + 1)),
    (error) =>
      error instanceof UsageError && error.message === 'Commands are limited to 1024 characters.',
  );
  assert.deepEqual(tokenize('x'.repeat(MAX_LINE)), ['x'.repeat(MAX_LINE)]);
});
