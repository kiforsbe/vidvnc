import test from 'node:test';
import assert from 'node:assert/strict';
import { bitrateText, targetBitrateText } from '../src/profile-labels.js';

test('bitrateText says up to only for variable bitrate profiles', () => {
  assert.equal(bitrateText({ bitrateKbps: 6000, bitrateMode: 'cbr' }), '6 Mbit/s');
  assert.equal(bitrateText({ bitrateKbps: 6000 }), '6 Mbit/s');
  assert.equal(bitrateText({ bitrateKbps: 6000, bitrateMode: 'vbr' }), 'up to 6 Mbit/s');
});

test('targetBitrateText says VBR up to only for variable bitrate profiles', () => {
  assert.equal(targetBitrateText({ bitrateKbps: 6000, bitrateMode: 'cbr' }), '6000 kbit/s');
  assert.equal(targetBitrateText({ bitrateKbps: 6000 }), '6000 kbit/s');
  assert.equal(
    targetBitrateText({ bitrateKbps: 6000, bitrateMode: 'vbr' }),
    'VBR up to 6000 kbit/s',
  );
});
