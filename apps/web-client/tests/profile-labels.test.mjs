import test from 'node:test';
import assert from 'node:assert/strict';
import { bitrateText, profileTooltip, targetBitrateText } from '../src/profile-labels.js';

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

test('profileTooltip lists the description then the size, rate and bitrate mode', () => {
  const cbr = {
    width: 1280,
    height: 720,
    fps: 15,
    bitrateKbps: 1000,
    bitrateMode: 'cbr',
    description: 'Small and steady',
  };
  assert.equal(profileTooltip(cbr), 'Small and steady\n1280 × 720 · 15 fps · 1 Mbit/s · Constant');
  const vbr = { ...cbr, bitrateKbps: 6000, bitrateMode: 'vbr', quality: 'high', description: '' };
  assert.equal(profileTooltip(vbr), '1280 × 720 · 15 fps · up to 6 Mbit/s · Variable (High)');
  assert.equal(profileTooltip({}), '');
});
