// Maps a pointer on the video element to a normalized desktop point. In immersive landscape
// mode on a portrait phone the stage is rotated 90° clockwise, so the element's own x axis
// runs down the screen and its y axis runs right to left.
export function videoPoint({ clientX, clientY }, rect, videoWidth, videoHeight, rotated = false) {
  if (!videoWidth || !videoHeight) return null;
  const local = rotated
    ? { x: clientY - rect.top, y: rect.right - clientX, width: rect.height, height: rect.width }
    : { x: clientX - rect.left, y: clientY - rect.top, width: rect.width, height: rect.height };
  const scale = Math.min(local.width / videoWidth, local.height / videoHeight);
  const width = videoWidth * scale,
    height = videoHeight * scale;
  const x = (local.x - (local.width - width) / 2) / width;
  const y = (local.y - (local.height - height) / 2) / height;
  // A hair outside an edge is rounding, not a miss.
  const inside = (value) => value >= -1e-6 && value <= 1 + 1e-6;
  const clamp = (value) => Math.min(1, Math.max(0, value));
  return inside(x) && inside(y) ? { x: clamp(x), y: clamp(y) } : null;
}

// Distance from the stage's own top edge, which is the screen's right edge when rotated.
export function distanceFromTop({ clientX, clientY }, rect, rotated = false) {
  return rotated ? rect.right - clientX : clientY - rect.top;
}

// Immersive mode stands in for element full screen where the browser has none (iPhone
// Safari only offers the native video player, which takes input away).
export function needsImmersive(env = globalThis) {
  const element = env.document?.documentElement;
  const nativeFullscreen = !!(env.document?.fullscreenEnabled && element?.requestFullscreen);
  return !nativeFullscreen && !!env.matchMedia?.('(pointer: coarse)').matches;
}
