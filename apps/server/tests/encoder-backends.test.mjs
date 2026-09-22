import test from 'node:test';
import assert from 'node:assert/strict';
import { selectEncoderBackend } from '../src/encoder-backends.mjs';

const backends = [
  { id: 'nvenc', onCaptureAdapter: false },
  { id: 'mediafoundation', onCaptureAdapter: true },
  { id: 'amf', onCaptureAdapter: true },
];

test('automatic encoder selection uses the startup probe affinity and fixed backend order', () => {
  assert.equal(selectEncoderBackend(backends), 'amf');
  assert.equal(
    selectEncoderBackend([
      { id: 'nvenc', onCaptureAdapter: true },
      { id: 'mediafoundation', onCaptureAdapter: true },
    ]),
    'nvenc',
  );
  assert.equal(
    selectEncoderBackend([{ id: 'mediafoundation', onCaptureAdapter: false }]),
    'mediafoundation',
  );
});

test('an installed explicit setting wins, while an unavailable one falls back to automatic', () => {
  assert.equal(selectEncoderBackend(backends, 'nvenc'), 'nvenc');
  assert.equal(selectEncoderBackend(backends, 'qsv'), 'amf');
  assert.equal(selectEncoderBackend([], 'nvenc'), 'auto');
});
