import { summarizeReceiver, summarizeAudioReceiver } from './receiver-stats.js';
import { videoCodecPreferences } from './codec-preferences.js';

// Used for the hardware-decode capability check before any answer has told us the real
// profile dimensions (see videoCodecPreferences in codec-preferences.js).
const DECODE_CHECK_PROFILE = { width: 1920, height: 1080, fps: 30, bitrateKbps: 4000 };

// One browser device owns several video peers and one independent audio peer.
export class StreamSubscriptions {
  constructor({ api, onSelect, onMetrics, onState, onControl, onAudio, playback = () => ({}) }) {
    Object.assign(this, { api, onSelect, onMetrics, onState, onControl, onAudio, playback });
    this.rows = new Map();
    this.selected = null;
    this.closed = false;
    this.controlStreamId = null;
    // Whether this device may take keyboard and mouse control itself right now (the host
    // allows it when available, and nobody else holds it).
    this.controlRequestable = false;
    this.lastProfile = DECODE_CHECK_PROFILE;
    this.timer = setInterval(() => this.sample(), 2000);
  }
  async negotiate(row, route, request) {
    await row.pc.setLocalDescription(await row.pc.createOffer());
    if (row.pc.iceGatheringState !== 'complete')
      await new Promise((resolve, reject) => {
        const changed = () => {
          if (row.pc.iceGatheringState === 'complete') finish();
        };
        const timer = setTimeout(() => finish(new Error('Connection setup timed out.')), 10000);
        const finish = (error) => {
          clearTimeout(timer);
          row.pc.removeEventListener('icegatheringstatechange', changed);
          error ? reject(error) : resolve();
        };
        row.pc.addEventListener('icegatheringstatechange', changed);
      });
    if (this.closed || row.closed) throw new Error('Connection cancelled.');
    const answer = await this.api(route, { ...request, sdp: row.pc.localDescription.sdp });
    row.id = answer.streamId;
    if (this.closed || row.closed) {
      if (route === 'stream-offer')
        await this.api('stream-stop', { streamId: row.id }).catch(() => {});
      throw new Error('Connection cancelled.');
    }
    Object.assign(row, { profile: answer.profile, display: answer.display });
    if (answer.profile) this.lastProfile = answer.profile;
    await row.pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
  }
  async select(request) {
    if (this.closed) throw new Error('Connection cancelled.');
    this.selected?.channel?.readyState === 'open' &&
      this.selected.channel.send(JSON.stringify({ type: 'release' }));
    let row = this.rows.get(request.displayId);
    if (row && row.request.profile !== request.profile) {
      await this.stop(row);
      row = null;
    }
    if (!row) {
      if (this.rows.size >= 2) await this.stop(this.selected ?? this.rows.values().next().value);
      row = {
        request: { ...request },
        pc: new RTCPeerConnection({ iceServers: [] }),
        closed: false,
      };
      const video = row.pc.addTransceiver('video', { direction: 'recvonly' });
      let codecs;
      try {
        codecs = await videoCodecPreferences(this.lastProfile);
      } catch (error) {
        row.pc.close();
        throw error;
      }
      video.setCodecPreferences(codecs);
      row.channel = row.pc.createDataChannel('input', { ordered: true });
      row.channel.onmessage = (e) => {
        if (this.selected !== row) return;
        try {
          const state = JSON.parse(e.data);
          if (typeof state.control === 'boolean')
            this.onControl(state.control, this.allowed(row), this.requestable(row));
        } catch {
          /* Unknown message. */
        }
      };
      row.channel.onopen = () => {
        if (this.selected === row) this.onControl(false, this.allowed(row), this.requestable(row));
      };
      row.channel.onclose = () => {
        if (this.selected === row) this.onControl(false, false);
      };
      row.pc.ontrack = (e) => {
        row.stream = new MediaStream([e.track]);
        if (this.selected === row) this.onSelect(row);
      };
      row.pc.onconnectionstatechange = () => {
        if (row.closed || this.closed) return;
        if (this.selected === row) this.onState(row.pc.connectionState);
      };
      this.rows.set(request.displayId, row);
      this.selected = row;
      this.onControl(false, false);
      try {
        await this.negotiate(row, 'stream-offer', request);
      } catch (error) {
        await this.stop(row);
        throw error;
      }
    }
    const selection = await this.api('stream-select', { streamId: row.id });
    if (this.closed || row.closed) throw new Error('Connection cancelled.');
    this.controlStreamId = selection.controlStreamId;
    this.controlRequestable = selection.controlRequestable === true;
    this.selected = row;
    this.onSelect(row);
    this.onControl(false, this.allowed(row), this.requestable(row));
    this.onState(row.pc.connectionState);
    return row;
  }
  allowed(row) {
    return !!row?.id && row.id === this.controlStreamId && row.channel?.readyState === 'open';
  }
  // The Control button may ask the host's server for control on this stream.
  requestable(row) {
    return (
      !!row?.id &&
      row === this.selected &&
      this.controlRequestable &&
      !this.allowed(row) &&
      row.channel?.readyState === 'open'
    );
  }
  // The user pressed Control while not holding it: ask for it. Resolves true once this
  // stream holds control; rejects with the server's reason otherwise.
  async requestControl() {
    const row = this.selected;
    if (!row?.id) throw new Error('Choose a display first.');
    const state = await this.api('control-request', { streamId: row.id });
    if (this.closed || this.selected !== row) return false;
    this.controlStreamId = state.controlStreamId;
    this.controlRequestable = state.controlRequestable === true;
    return this.allowed(row);
  }
  // The user released control: hand back control this device took itself, so another device
  // can ask. Control the host granted stays with this device.
  releaseControl() {
    if (this.closed) return;
    this.api('control-release')
      .then((state) => {
        if (this.closed || !state) return;
        this.controlStreamId = state.controlStreamId;
        this.controlRequestable = state.controlRequestable === true;
        if (this.selected)
          this.onControl(false, this.allowed(this.selected), this.requestable(this.selected));
      })
      .catch(() => {});
  }
  update(state, knownIds) {
    this.controlStreamId = state.controlStreamId;
    this.controlRequestable = state.controlRequestable === true;
    for (const row of [...this.rows.values()]) {
      if (row.id && knownIds.has(row.id) && !state.streams.some((s) => s.streamId === row.id)) {
        const selected = this.selected === row;
        this.closeRow(row);
        if (selected) {
          this.onSelect(null);
          this.onState('ended');
        }
      }
    }
    if (!this.allowed(this.selected)) this.onControl(false, false, this.requestable(this.selected));
    else this.onControl(null, true, false);
  }
  async startAudio() {
    const row = (this.audio = { pc: new RTCPeerConnection({ iceServers: [] }) });
    row.pc.addTransceiver('audio', { direction: 'recvonly' });
    row.pc.ontrack = (e) => {
      if (!this.closed) this.onAudio(new MediaStream([e.track]));
    };
    try {
      await this.negotiate(row, 'audio-offer', {});
    } catch (error) {
      row.pc.close();
      throw error;
    }
  }
  async sample() {
    if (this.closed || this.sampling) return;
    this.sampling = true;
    try {
      if (this.audio?.id) {
        const stats = await this.audio.pc.getStats();
        const report = [...stats.values()].find(
          (r) => r.type === 'inbound-rtp' && (r.kind || r.mediaType) === 'audio',
        );
        if (report && !this.closed) {
          const metrics = summarizeAudioReceiver(report, this.audio.previous);
          this.audio.previous = report;
          await this.api('audio-telemetry', { streamId: this.audio.id, ...metrics }).catch(
            () => {},
          );
        }
      }
      await Promise.all(
        [...this.rows.values()].map(async (row) => {
          if (!row.id || row.closed) return;
          if (row.channel.readyState === 'open' && row.channel.bufferedAmount < 65536)
            row.channel.send(JSON.stringify({ type: 'ping' }));
          const stats = await row.pc.getStats();
          if (row.closed || this.closed) return;
          const report = [...stats.values()].find(
            (r) => r.type === 'inbound-rtp' && (r.kind || r.mediaType) === 'video',
          );
          if (!report) return;
          const transport = stats.get(report.transportId);
          const pair = stats.get(transport?.selectedCandidatePairId);
          const metrics = summarizeReceiver(report, row.previous, pair);
          row.previous = report;
          if (this.selected === row) this.onMetrics(metrics);
          // The video element shows only the selected stream, so only its row reports playback.
          const playback = this.selected === row ? this.playback() : {};
          await this.api('stream-telemetry', { streamId: row.id, ...metrics, ...playback });
        }),
      );
    } catch {
      /* A missing stats field or stopped peer must not tear down its siblings. */
    } finally {
      this.sampling = false;
    }
  }
  closeRow(row, closePeer = true) {
    if (!row || row.closed) return;
    row.closed = true;
    if (closePeer) {
      row.channel?.close();
      row.pc.close();
    }
    this.rows.delete(row.request?.displayId);
    if (this.selected === row) this.selected = null;
  }
  async stop(row) {
    if (!row) return;
    if (row.channel?.readyState === 'open') row.channel.send(JSON.stringify({ type: 'release' }));
    this.closeRow(row, false);
    try {
      if (row.id) await this.api('stream-stop', { streamId: row.id });
    } finally {
      row.channel?.close();
      row.pc.close();
    }
  }
  close(closePeers = true) {
    this.closed = true;
    clearInterval(this.timer);
    if (closePeers) {
      for (const row of [...this.rows.values()]) this.closeRow(row);
      this.audio?.pc.close();
    }
  }
}
