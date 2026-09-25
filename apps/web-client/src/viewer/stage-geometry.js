// Maps a pointer on the video element to a normalized desktop point, allowing for the
// letterbox bars object-fit: contain adds around the picture.
export function videoPoint({ clientX, clientY }, rect, videoWidth, videoHeight) {
  if (!videoWidth || !videoHeight) return null;
  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
  const width = videoWidth * scale,
    height = videoHeight * scale;
  const x = (clientX - rect.left - (rect.width - width) / 2) / width;
  const y = (clientY - rect.top - (rect.height - height) / 2) / height;
  // A hair outside an edge is rounding, not a miss.
  const inside = (value) => value >= -1e-6 && value <= 1 + 1e-6;
  const clamp = (value) => Math.min(1, Math.max(0, value));
  return inside(x) && inside(y) ? { x: clamp(x), y: clamp(y) } : null;
}

// Immersive mode stands in for element full screen where the browser has none (iPhone
// Safari only offers the native video player, which takes input away).
export function needsImmersive(env = globalThis) {
  const element = env.document?.documentElement;
  const nativeFullscreen = !!(env.document?.fullscreenEnabled && element?.requestFullscreen);
  return !nativeFullscreen && !!env.matchMedia?.('(pointer: coarse)').matches;
}
