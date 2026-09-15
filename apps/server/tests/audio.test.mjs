import test from 'node:test';
import assert from 'node:assert/strict';
import { audioModes, chooseAudioMode, getAudioMode } from '../src/audio.mjs';

test('audio contract defaults to stereo Opus system audio', () => {
  assert.deepEqual(audioModes(), ['on', 'off']);
  assert.deepEqual(chooseAudioMode(), {
    mode: 'on',
    enabled: true,
    codec: 'Opus',
    compression: 'lossy',
    sampleRate: 48000,
    channels: 2,
    bitrateKbps: 96,
  });
  assert.equal(getAudioMode('off').enabled, false);
  assert.equal(chooseAudioMode('unknown').mode, 'on');
});

test('audio mode never enables microphone capture', () => {
  assert.equal(getAudioMode('on').microphone, undefined);
});
