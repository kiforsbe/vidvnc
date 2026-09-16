// Duplicated from apps/server/src/video-codecs.mjs CODEC_LABELS: the browser bundle must
// not import server code, so the three display labels are kept in sync here by hand.
export const CODEC_LABELS = Object.freeze({ av1: 'AV1', h265: 'H.265', h264: 'H.264' });

// Order matters: this is the order hardware-decodable codecs are placed ahead of H.264.
const HARDWARE_MIMES = ['video/AV1', 'video/H265'];

function byMime(codecs, mime) {
  return codecs.filter((c) => c.mimeType.toLowerCase() === mime.toLowerCase());
}

async function isPowerEfficient(mediaCapabilities, mime, profile) {
  if (!mediaCapabilities) return false;
  try {
    const result = await mediaCapabilities.decodingInfo({
      type: 'webrtc',
      video: {
        contentType: mime,
        width: profile.width,
        height: profile.height,
        bitrate: profile.bitrateKbps * 1000,
        framerate: profile.fps,
      },
    });
    return !!(result && result.supported && result.powerEfficient);
  } catch {
    return false;
  }
}

export async function videoCodecPreferences(profile, env = globalThis) {
  const all = env.RTCRtpReceiver.getCapabilities('video').codecs;
  const h264 = byMime(all, 'video/h264');
  if (h264.length === 0) throw new Error('This browser cannot decode H.264.');

  let hardware = [];
  if (profile) {
    const mediaCapabilities = env.navigator?.mediaCapabilities;
    const groups = await Promise.all(
      HARDWARE_MIMES.map(async (mime) => {
        const entries = byMime(all, mime);
        if (entries.length === 0) return [];
        const efficient = await isPowerEfficient(mediaCapabilities, mime, profile);
        return efficient ? entries : [];
      }),
    );
    hardware = groups.flat();
  }
  return [...hardware, ...h264, ...byMime(all, 'video/rtx')];
}
