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

test('a profile says how its size follows the shared screen', async () => {
  const { sizeText } = await import('../src/profile-labels.js');
  assert.equal(sizeText({ sizing: 'height', width: 1920, height: 1080 }), '1080p');
  assert.equal(sizeText({ sizing: 'width', width: 1280, height: 720 }), '1280 wide');
  assert.equal(sizeText({ sizing: 'scale', scalePercent: 150 }), '150% of screen');
  assert.equal(
    sizeText({ sizing: 'fixed', aspect: 'keep', width: 1920, height: 1080 }),
    'up to 1920 × 1080',
  );
  assert.equal(
    sizeText({ sizing: 'fixed', aspect: 'fit', width: 1920, height: 1080 }),
    '1920 × 1080',
  );
  assert.equal(
    sizeText({ sizing: 'fixed', aspect: 'stretch', width: 800, height: 600 }),
    '800 × 600 stretched',
  );
  // A running stream's profile has only its actual size.
  assert.equal(sizeText({ width: 1662, height: 1080 }), '1662 × 1080');
});
