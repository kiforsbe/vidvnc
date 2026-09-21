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

// A probe backend entry. Minimum input size is a property of the element, not of the codec,
// which is the whole reason eligibility moved out of a codec-keyed table.
const backend = (id, minimums) => ({
  id,
  label: id,
  codecs: Object.keys(minimums),
  minimums,
});
const NVENC = backend('nvenc', {
  av1: { width: 192, height: 128 },
  h265: { width: 144, height: 48 },
  h264: { width: 64, height: 64 },
});
const QSV = backend('qsv', {
  av1: { width: 16, height: 16 },
  h265: { width: 16, height: 16 },
  h264: { width: 16, height: 16 },
});
const MF = backend('mediafoundation', {
  h265: { width: 64, height: 64 },
  h264: { width: 64, height: 64 },
});
const H264_ONLY = backend('nvenc', { h264: { width: 64, height: 64 } });

test('Chrome-like offer with full policy and host support selects AV1', () => {
  assert.equal(selectVideoCodec(chromeSdp, ALL_CODECS, [NVENC], desktopProfile, 'auto'), 'av1');
});

test('Safari-like offer without AV1 selects H.265', () => {
  assert.equal(selectVideoCodec(safariSdp, ALL_CODECS, [NVENC], desktopProfile, 'auto'), 'h265');
});

test('H.264-only offer selects H.264', () => {
  assert.equal(selectVideoCodec(h264OnlySdp, ALL_CODECS, [NVENC], desktopProfile, 'auto'), 'h264');
});

test('host support limited to H.264 selects H.264 even when AV1 is offered', () => {
  assert.equal(
    selectVideoCodec(av1H264Sdp, ALL_CODECS, [H264_ONLY], desktopProfile, 'auto'),
    'h264',
  );
});

test('policy order wins over browser offer order', () => {
  assert.equal(
    selectVideoCodec(av1H264Sdp, ['h264', 'av1'], [NVENC], desktopProfile, 'auto'),
    'h264',
  );
});

test('a small profile falls back past codecs whose encoder minimum it does not meet', () => {
  assert.equal(
    selectVideoCodec(av1H265H264Sdp, ALL_CODECS, [NVENC], { width: 160, height: 90 }, 'auto'),
    'h265',
  );
  assert.equal(
    selectVideoCodec(av1H265H264Sdp, ALL_CODECS, [NVENC], { width: 128, height: 64 }, 'auto'),
    'h264',
  );
});

// The case a codec-keyed minimum table could not express: whether 100x100 can carry AV1
// depends on which encoder would encode it, not on AV1.
test('a size too small for one backend is allowed when another backend can encode it', () => {
  const profile = { width: 100, height: 100 };
  assert.equal(selectVideoCodec(av1H264Sdp, ALL_CODECS, [NVENC], profile, 'auto'), 'h264');
  assert.equal(selectVideoCodec(av1H264Sdp, ALL_CODECS, [NVENC, QSV], profile, 'auto'), 'av1');
});

test('policy order still decides when several backends support everything', () => {
  assert.equal(
    selectVideoCodec(av1H265H264Sdp, ['h265', 'av1', 'h264'], [NVENC, QSV], desktopProfile, 'auto'),
    'h265',
  );
});

test('a forced backend narrows the choice to what that backend can encode', () => {
  assert.equal(
    selectVideoCodec(av1H265H264Sdp, ALL_CODECS, [NVENC, MF], desktopProfile, 'mediafoundation'),
    'h265',
  );
});

// Mirrors the worker: a backend this machine does not have falls back to automatic rather
// than narrowing the choice to nothing.
test('forcing a backend that is not installed behaves exactly as automatic', () => {
  assert.equal(
    selectVideoCodec(av1H265H264Sdp, ALL_CODECS, [NVENC], desktopProfile, 'qsv'),
    selectVideoCodec(av1H265H264Sdp, ALL_CODECS, [NVENC], desktopProfile, 'auto'),
  );
});

test('no backends at all is a 400 rather than a crash', () => {
  assert.throws(
    () => selectVideoCodec(chromeSdp, ALL_CODECS, [], desktopProfile, 'auto'),
    (error) =>
      error.status === 400 && error.message === 'Browser must offer a supported video codec.',
  );
});

test('a codec named only in the audio section does not count as offered', () => {
  const audioOnlyH264 = sdp(['a=rtpmap:96 VP8/90000'], ['a=rtpmap:111 H264/90000']);
  assert.throws(
    () => selectVideoCodec(audioOnlyH264, ALL_CODECS, [NVENC], desktopProfile, 'auto'),
    (error) =>
      error.status === 400 && error.message === 'Browser must offer a supported video codec.',
  );
});

test('lower-case rtpmap names are recognised', () => {
  const lowerCaseAv1 = sdp(['a=rtpmap:98 av1/90000']);
  assert.deepEqual(offeredVideoCodecs(lowerCaseAv1), new Set(['av1']));
  assert.equal(selectVideoCodec(lowerCaseAv1, ALL_CODECS, [NVENC], desktopProfile, 'auto'), 'av1');
});
