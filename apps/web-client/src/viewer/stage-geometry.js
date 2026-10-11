// Maps a pointer on the video element to a normalized desktop point, allowing for the
// letterbox bars object-fit: contain adds around the picture, and for the bars the host
// encodes into the frame itself when the screen's shape differs from the profile's (both
// ScreenCaptureKit and d3d11convert scale the screen to fit, centred). `source` is the shared
// display's size; without it the whole frame is the desktop, as before.
export function videoPoint({ clientX, clientY }, rect, videoWidth, videoHeight, source = null) {
  if (!videoWidth || !videoHeight) return null;
  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
  const width = videoWidth * scale,
    height = videoHeight * scale;
  let x = (clientX - rect.left - (rect.width - width) / 2) / width;
  let y = (clientY - rect.top - (rect.height - height) / 2) / height;
  if (source?.width > 0 && source?.height > 0) {
    const fit = Math.min(videoWidth / source.width, videoHeight / source.height);
    const contentWidth = (source.width * fit) / videoWidth,
      contentHeight = (source.height * fit) / videoHeight;
    x = (x - (1 - contentWidth) / 2) / contentWidth;
    y = (y - (1 - contentHeight) / 2) / contentHeight;
  }
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
