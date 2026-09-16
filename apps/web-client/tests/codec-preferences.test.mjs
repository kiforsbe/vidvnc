import test from 'node:test';
import assert from 'node:assert/strict';
import { videoCodecPreferences } from '../src/codec-preferences.js';

const profile = { width: 1920, height: 1080, fps: 30, bitrateKbps: 4000 };

const baseCodecs = [
  { mimeType: 'video/AV1', clockRate: 90000 },
  { mimeType: 'video/H265', clockRate: 90000 },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'profile-a' },
  { mimeType: 'video/H264', clockRate: 90000, sdpFmtpLine: 'profile-b' },
  { mimeType: 'video/rtx', clockRate: 90000 },
  { mimeType: 'video/VP8', clockRate: 90000 },
];

function envWithCodecs(codecs, decodingInfo) {
  return {
    RTCRtpReceiver: { getCapabilities: () => ({ codecs }) },
    navigator: decodingInfo === undefined ? {} : { mediaCapabilities: { decodingInfo } },
  };
}

test('orders av1, h265, h264 x2, rtx when both hardware decode checks are power efficient, dropping VP8', async () => {
  const env = envWithCodecs(baseCodecs, async () => ({ supported: true, powerEfficient: true }));
  const result = await videoCodecPreferences(profile, env);
  assert.deepEqual(
    result.map((c) => c.mimeType),
    ['video/AV1', 'video/H265', 'video/H264', 'video/H264', 'video/rtx'],
  );
});

test('excludes AV1 when decoding is supported but not power efficient', async () => {
  const env = envWithCodecs(baseCodecs, async ({ video }) =>
    video.contentType === 'video/AV1'
      ? { supported: true, powerEfficient: false }
      : { supported: true, powerEfficient: true },
  );
  const result = await videoCodecPreferences(profile, env);
  assert.ok(!result.some((c) => c.mimeType === 'video/AV1'));
  assert.ok(result.some((c) => c.mimeType === 'video/H265'));
});

test('excludes H265 when its decodingInfo rejects, AV1 remains present', async () => {
  const env = envWithCodecs(baseCodecs, async ({ video }) => {
    if (video.contentType === 'video/H265') throw new Error('boom');
    return { supported: true, powerEfficient: true };
  });
  const result = await videoCodecPreferences(profile, env);
  assert.ok(!result.some((c) => c.mimeType === 'video/H265'));
  assert.ok(result.some((c) => c.mimeType === 'video/AV1'));
});

test('skips hardware codecs entirely when navigator.mediaCapabilities is undefined', async () => {
  const env = envWithCodecs(baseCodecs, undefined);
  const result = await videoCodecPreferences(profile, env);
  assert.deepEqual(
    result.map((c) => c.mimeType),
    ['video/H264', 'video/H264', 'video/rtx'],
  );
});

test('throws when the browser cannot decode H.264', async () => {
  const codecs = baseCodecs.filter((c) => c.mimeType !== 'video/H264');
  const env = envWithCodecs(codecs, async () => ({ supported: true, powerEfficient: true }));
  await assert.rejects(
    () => videoCodecPreferences(profile, env),
    /This browser cannot decode H\.264\./,
  );
});

test('decodingInfo receives type webrtc, mime contentType, and bitrate in bits per second', async () => {
  const calls = [];
  const env = envWithCodecs(baseCodecs, async (config) => {
    calls.push(config);
    return { supported: true, powerEfficient: true };
  });
  await videoCodecPreferences(profile, env);
  const av1Call = calls.find((c) => c.video.contentType === 'video/AV1');
  assert.ok(av1Call, 'AV1 decodingInfo should have been called');
  assert.equal(av1Call.type, 'webrtc');
  assert.equal(av1Call.video.width, 1920);
  assert.equal(av1Call.video.height, 1080);
  assert.equal(av1Call.video.framerate, 30);
  assert.equal(av1Call.video.bitrate, 4000000);
});

test('skips the decode check entirely when profile is undefined, decodingInfo is never called', async () => {
  let called = false;
  const env = envWithCodecs(baseCodecs, async () => {
    called = true;
    return { supported: true, powerEfficient: true };
  });
  const result = await videoCodecPreferences(undefined, env);
  assert.equal(called, false);
  assert.deepEqual(
    result.map((c) => c.mimeType),
    ['video/H264', 'video/H264', 'video/rtx'],
  );
});
