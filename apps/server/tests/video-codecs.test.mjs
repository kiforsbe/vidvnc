import test from 'node:test';
import assert from 'node:assert/strict';
import { offeredVideoCodecs, selectVideoCodec } from '../src/video-codecs.mjs';

const sdp = (videoRtpmaps, audioRtpmaps = ['a=rtpmap:111 opus/48000/2']) =>
  [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99',
    ...videoRtpmaps,
    'm=audio 9 UDP/TLS/RTP/SAVPF 111',
    ...audioRtpmaps,
  ].join('\r\n');

const chromeSdp = sdp([
  'a=rtpmap:96 VP8/90000',
  'a=rtpmap:97 VP9/90000',
  'a=rtpmap:98 AV1/90000',
  'a=rtpmap:99 H264/90000',
]);
const safariSdp = sdp(['a=rtpmap:96 H265/90000', 'a=rtpmap:97 H264/90000']);
const h264OnlySdp = sdp(['a=rtpmap:96 H264/90000']);
const av1H264Sdp = sdp(['a=rtpmap:96 AV1/90000', 'a=rtpmap:97 H264/90000']);
const av1H265H264Sdp = sdp([
  'a=rtpmap:96 AV1/90000',
  'a=rtpmap:97 H265/90000',
  'a=rtpmap:98 H264/90000',
]);

const ALL_CODECS = ['av1', 'h265', 'h264'];
const desktopProfile = { width: 1280, height: 720 };

test('Chrome-like offer with full policy and host support selects AV1', () => {
  assert.equal(selectVideoCodec(chromeSdp, ALL_CODECS, ALL_CODECS, desktopProfile), 'av1');
});

test('Safari-like offer without AV1 selects H.265', () => {
  assert.equal(selectVideoCodec(safariSdp, ALL_CODECS, ALL_CODECS, desktopProfile), 'h265');
});

test('H.264-only offer selects H.264', () => {
  assert.equal(selectVideoCodec(h264OnlySdp, ALL_CODECS, ALL_CODECS, desktopProfile), 'h264');
});

test('host support limited to H.264 selects H.264 even when AV1 is offered', () => {
  assert.equal(selectVideoCodec(av1H264Sdp, ALL_CODECS, ['h264'], desktopProfile), 'h264');
});

test('policy order wins over browser offer order', () => {
  assert.equal(selectVideoCodec(av1H264Sdp, ['h264', 'av1'], ALL_CODECS, desktopProfile), 'h264');
});

test('a small profile falls back past codecs whose encoder minimum it does not meet', () => {
  assert.equal(
    selectVideoCodec(av1H265H264Sdp, ALL_CODECS, ALL_CODECS, { width: 160, height: 90 }),
    'h265',
  );
  assert.equal(
    selectVideoCodec(av1H265H264Sdp, ALL_CODECS, ALL_CODECS, { width: 128, height: 64 }),
    'h264',
  );
});

test('a codec named only in the audio section does not count as offered', () => {
  const audioOnlyH264 = sdp(['a=rtpmap:96 VP8/90000'], ['a=rtpmap:111 H264/90000']);
  assert.throws(
    () => selectVideoCodec(audioOnlyH264, ALL_CODECS, ALL_CODECS, desktopProfile),
    (error) =>
      error.status === 400 && error.message === 'Browser must offer a supported video codec.',
  );
});

test('lower-case rtpmap names are recognised', () => {
  const lowerCaseAv1 = sdp(['a=rtpmap:98 av1/90000']);
  assert.deepEqual(offeredVideoCodecs(lowerCaseAv1), new Set(['av1']));
  assert.equal(selectVideoCodec(lowerCaseAv1, ALL_CODECS, ALL_CODECS, desktopProfile), 'av1');
});
