import assert from 'node:assert/strict';
import test from 'node:test';
import { distanceFromTop, needsImmersive, videoPoint } from '../src/viewer/stage-geometry.js';

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

test('a stage rotated 90° clockwise on a portrait phone maps screen to desktop', () => {
  // A 390×844 portrait screen showing a landscape 844×390 stage turned clockwise.
  const rect = { left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844 };
  // 16:9 in the stage's own 844×390 is 693.33×390, with 75.33 px bars at its left and right,
  // which are the screen's top and bottom.
  const bar = (844 - (390 * 16) / 9) / 2;
  // The desktop's top-left sits at the screen's top-right, below the bar.
  close(videoPoint({ clientX: 390, clientY: bar }, rect, 1920, 1080, true), { x: 0, y: 0 });
  // Its bottom-right sits at the screen's bottom-left, above the bar.
  close(videoPoint({ clientX: 0, clientY: 844 - bar }, rect, 1920, 1080, true), { x: 1, y: 1 });
  // Moving down the screen moves right on the desktop; moving left moves down.
  close(videoPoint({ clientX: 195, clientY: 422 }, rect, 1920, 1080, true), { x: 0.5, y: 0.5 });
  close(videoPoint({ clientX: 390, clientY: 422 }, rect, 1920, 1080, true), { x: 0.5, y: 0 });
  assert.equal(videoPoint({ clientX: 195, clientY: 10 }, rect, 1920, 1080, true), null);
});

test('the stage top is the screen right edge when rotated', () => {
  const rect = { left: 0, top: 0, right: 390, bottom: 844, width: 390, height: 844 };
  assert.equal(distanceFromTop({ clientX: 380, clientY: 500 }, rect, true), 10);
  assert.equal(distanceFromTop({ clientX: 380, clientY: 500 }, rect, false), 500);
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
