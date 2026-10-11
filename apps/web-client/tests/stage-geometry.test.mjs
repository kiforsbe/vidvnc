import assert from 'node:assert/strict';
import test from 'node:test';
import { needsImmersive, videoPoint } from '../src/viewer/stage-geometry.js';

const close = (actual, expected) => {
  assert.ok(actual, 'point inside the video');
  assert.ok(
    Math.abs(actual.x - expected.x) < 1e-9 && Math.abs(actual.y - expected.y) < 1e-9,
    `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
  );
};

test('an upright stage maps corners and letterbox bars', () => {
  const rect = { left: 10, top: 20, right: 410, bottom: 320, width: 400, height: 300 };
  // 16:9 in 400×300 is 400×225, centred with 37.5 px bars above and below.
  close(videoPoint({ clientX: 10, clientY: 57.5 }, rect, 1920, 1080), { x: 0, y: 0 });
  close(videoPoint({ clientX: 410, clientY: 282.5 }, rect, 1920, 1080), { x: 1, y: 1 });
  close(videoPoint({ clientX: 210, clientY: 170 }, rect, 1920, 1080), { x: 0.5, y: 0.5 });
  assert.equal(videoPoint({ clientX: 210, clientY: 30 }, rect, 1920, 1080), null);
  assert.equal(videoPoint({ clientX: 210, clientY: 170 }, rect, 0, 0), null);
});

test('a full-screen portrait stage letterboxes a landscape desktop above and below', () => {
  const rect = { left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844 };
  const bar = (844 - (390 * 9) / 16) / 2;
  close(videoPoint({ clientX: 0, clientY: bar }, rect, 1920, 1080), { x: 0, y: 0 });
  close(videoPoint({ clientX: 390, clientY: 844 - bar }, rect, 1920, 1080), { x: 1, y: 1 });
  assert.equal(videoPoint({ clientX: 195, clientY: bar - 5 }, rect, 1920, 1080), null);
});

test('bars the host encoded into the frame are not part of the desktop', () => {
  // A 1512×982 Mac screen in a 1920×1080 stream: scaled to 1662.9×1080, centred with
  // 128.5 px bars left and right in the frame. The element shows the frame at 1920×1080.
  const rect = { left: 0, top: 0, right: 1920, bottom: 1080, width: 1920, height: 1080 };
  const source = { width: 1512, height: 982 };
  const bar = (1920 - (1512 * 1080) / 982) / 2;
  close(videoPoint({ clientX: bar, clientY: 0 }, rect, 1920, 1080, source), { x: 0, y: 0 });
  close(videoPoint({ clientX: 1920 - bar, clientY: 1080 }, rect, 1920, 1080, source), {
    x: 1,
    y: 1,
  });
  close(videoPoint({ clientX: 960, clientY: 540 }, rect, 1920, 1080, source), { x: 0.5, y: 0.5 });
  assert.equal(videoPoint({ clientX: bar / 2, clientY: 540 }, rect, 1920, 1080, source), null);
  // A screen with the stream's own shape has no bars.
  close(videoPoint({ clientX: 0, clientY: 0 }, rect, 1920, 1080, { width: 2560, height: 1440 }), {
    x: 0,
    y: 0,
  });
});

test('immersive mode is only for touch browsers without element full screen', () => {
  const env = (fullscreenEnabled, coarse) => ({
    document: { fullscreenEnabled, documentElement: { requestFullscreen() {} } },
    matchMedia: () => ({ matches: coarse }),
  });
  assert.equal(needsImmersive(env(false, true)), true);
  assert.equal(needsImmersive(env(true, true)), false);
  assert.equal(needsImmersive(env(false, false)), false);
});
