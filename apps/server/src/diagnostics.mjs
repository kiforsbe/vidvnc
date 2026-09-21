import { mkdir, appendFile, stat, rename } from 'node:fs/promises';
import path from 'node:path';

const fields = {
  server:
    'elapsedMs captureFrames encoderInputFrames encodedFrames encodedBytes captureFps encodeFps encodedMbps maxFrameBytes captureGapMaxMs pendingFrames encodeMeanMs encodeMaxMs qosEvents qosDroppedMax audioCaptureBuffers audioEncodedPackets audioEncodedBytes forceKeyUnitEvents encodedKeyframes spsProfile spsLevel'.split(
      ' ',
    ),
  client:
    'receiveMbps decodeFps framesReceived framesDecoded framesDropped packetsLost packetsReceived lostInterval nackCount pliCount firCount keyFramesDecoded completeFrameFps videoPaused videoReadyState jitterMs decodeMs jitterBufferMs freezeCount freezeSeconds rttMs frameWidth frameHeight audioPacketsLost audioPacketsReceived audioJitterMs audioConcealedSamples'.split(
      ' ',
    ),
};
fields.server.push(
  ...'videoRtpPackets videoRtpBytes videoRtpPeak1msBytes videoRtpPeak10msBytes videoRtpWindowTruncated iceInputPackets iceInputBytes iceInputPeak1msBytes iceInputPeak10msBytes iceInputWindowTruncated rtxSenders rtxRequests rtxPackets queueMaxBytesSampled queueMaxMsSampled'.split(
    ' ',
  ),
);
export class Diagnostics {
  constructor({ clock = Date.now, limit = 600, directory = null } = {}) {
    this.clock = clock;
    this.limit = limit;
    this.directory = directory;
    this.history = [];
    this.latest = {};
    this.pending = 0;
    this.writes = Promise.resolve();
    this.logError = null;
  }
  record(source, input) {
    if (!fields[source] || !input || typeof input !== 'object' || Array.isArray(input))
      return false;
    const values = Object.fromEntries(
      fields[source].map((key) => [
        key,
        typeof input[key] === 'number' && Number.isFinite(input[key]) && Math.abs(input[key]) < 1e15
          ? input[key]
          : null,
      ]),
    );
    const sample = { source, at: this.clock(), ...values };
    this.latest[source] = sample;
    this.history.push(sample);
    if (this.history.length > this.limit) this.history.shift();
    // Drop log work if disk falls behind; never stall video or accumulate writes.
    if (this.directory && this.pending < 8) {
      this.pending++;
      this.writes = this.writes
        .then(async () => {
          await mkdir(this.directory, { recursive: true });
          const file = path.join(this.directory, 'metrics.ndjson');
          const size = await stat(file)
            .then((s) => s.size)
            .catch((error) => {
              if (error.code === 'ENOENT') return 0;
              throw error;
            });
          if (size > 5 * 1024 * 1024)
            await rename(file, path.join(this.directory, 'metrics.previous.ndjson'));
          await appendFile(file, JSON.stringify(sample) + '\n');
        })
        .catch((error) => {
          this.logError = error.code || 'Log write failed';
        })
        .finally(() => this.pending--);
    }
    return true;
  }
  reset(configuration = null) {
    this.latest = {};
    this.history = [];
    this.configuration = configuration;
  }
  startStream(profile, audio, display, codec) {
    this.reset({
      profile: { ...profile },
      audio: {
        enabled: audio.mode !== 'off',
        codec: 'Opus',
        channels: profile.fps === 15 ? 1 : 2,
        bitrateKbps: profile.fps === 15 ? 32 : 96,
      },
      display: display
        ? Object.fromEntries(
            ['id', 'number', 'name', 'width', 'height', 'x', 'y', 'rotation', 'primary'].map(
              (key) => [key, display[key]],
            ),
          )
        : null,
      codec,
      // Filled in once the worker reports which encoder it actually selected, which is after
      // the stream is configured but before any frame is delivered.
      encoder: null,
    });
  }
  setEncoder(encoder) {
    if (this.configuration) this.configuration.encoder = encoder ? { ...encoder } : null;
  }
  snapshot() {
    const now = this.clock();
    return {
      at: now,
      configuration: this.configuration || null,
      server: this.latest.server || null,
      client: this.latest.client || null,
      serverAgeMs: this.latest.server ? now - this.latest.server.at : null,
      clientAgeMs: this.latest.client ? now - this.latest.client.at : null,
      history: this.history.slice(),
      logError: this.logError,
    };
  }
}
