import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeReceiver, summarizeAudioReceiver } from '../src/receiver-stats.js';

test('receiver interval rates and decode/jitter delays use deltas, not lifetime averages', () => {
  const previous = {
    id: 'video',
    timestamp: 1000,
    bytesReceived: 1000000,
    framesDecoded: 30,
    totalDecodeTime: 0.15,
    jitterBufferDelay: 0.3,
    jitterBufferEmittedCount: 30,
  };
  const current = {
    ...previous,
    timestamp: 3000,
    bytesReceived: 1500000,
    framesDecoded: 70,
    totalDecodeTime: 0.55,
    jitterBufferDelay: 1.1,
    jitterBufferEmittedCount: 70,
    framesDropped: 3,
    jitter: 0.02,
  };
  const result = summarizeReceiver(current, previous);
  assert.equal(result.receiveMbps, 2);
  assert.equal(result.decodeFps, 20);
  assert.equal(result.decodeMs, 10);
  assert.equal(result.jitterBufferMs, 20);
  assert.equal(result.jitterMs, 20);
  assert.equal(result.framesDropped, 3);
});
test('unsupported receiver metrics and reset counters are unavailable, not zero', () => {
  const result = summarizeReceiver(
    { id: 'new', timestamp: 1000 },
    { id: 'old', timestamp: 0, bytesReceived: 1 },
  );
  assert.equal(result.receiveMbps, null);
  assert.equal(result.framesDropped, null);
  assert.equal(result.freezeCount, null);
});
test('audio receiver metrics use the same interval-safe delta rules', () => {
  const first = {
    id: 'audio',
    timestamp: 1000,
    packetsReceived: 100,
    packetsLost: 2,
    jitter: 0.004,
    concealedSamples: 10,
  };
  const second = {
    id: 'audio',
    timestamp: 3000,
    packetsReceived: 180,
    packetsLost: 5,
    jitter: 0.006,
    concealedSamples: 25,
  };
  assert.deepEqual(summarizeAudioReceiver(second, first), {
    audioPacketsLost: 5,
    audioPacketsReceived: 180,
    audioLostInterval: 3,
    audioJitterMs: 6,
    audioConcealedSamples: 25,
  });
});
