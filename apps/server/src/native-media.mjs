import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { executable, workerEnvironment } from '@vidvnc/media-worker/runtime';
import { Recovery } from './recovery.mjs';
import { Diagnostics } from './diagnostics.mjs';
import { peerSample } from './media-sample.mjs';
import { DEFAULT_BITRATE_MODE, DEFAULT_QUALITY } from './rate-control.mjs';

export function probe() {
  const info = JSON.parse(
    execFileSync(executable, ['--probe'], {
      env: workerEnvironment(),
      windowsHide: true,
      timeout: 15000,
      encoding: 'utf8',
    }),
  );
  // A worker built before encoder backends existed reports codecs but no backends. Defaulting
  // to an empty list keeps such a binary from crashing the server at startup; codec selection
  // then finds nothing eligible and says so per request, which is the honest failure.
  return { ...info, backends: Array.isArray(info.backends) ? info.backends : [] };
}
export async function listDisplays(signal) {
  const { stdout } = await promisify(execFile)(executable, ['--list-displays'], {
    env: workerEnvironment(),
    signal,
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 65536,
  });
  return JSON.parse(stdout);
}
const busy = (message) => Object.assign(new Error(message), { code: 'MEDIA_BUSY' });

// One worker per source (a capture/encode or an audio mix); each viewer is a peer inside it.
export class NativeMedia {
  constructor({
    onExit = () => {},
    onMetrics = () => {},
    onPeerFailed = () => {},
    diagnostics = null,
    maxWorkers = 1,
    hostControl = false,
    negotiationTimeoutMs = 15000,
    removalTimeoutMs = 1500,
    launch = () =>
      spawn(executable, ['--session'], {
        env: workerEnvironment(),
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
  } = {}) {
    if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 64)
      throw new Error('Invalid worker limit');
    this.onExit = onExit;
    this.onMetrics = onMetrics;
    this.onPeerFailed = onPeerFailed;
    this.workers = new Map();
    this.maxWorkers = maxWorkers;
    this.launch = launch;
    this.hostControl = hostControl;
    this.negotiationTimeoutMs = negotiationTimeoutMs;
    this.removalTimeoutMs = removalTimeoutMs;
    this.permissionSequence = 0;
    this.diagnostics = diagnostics;
  }
  // Compatibility for the single-stream host until its status contract migrates.
  get active() {
    return this.workers.values().next().value ?? null;
  }
  start(
    sourceId,
    {
      video = true,
      profile = { name: 'desktop' },
      display = null,
      audioFormat,
      codec,
      encoderBackend,
    } = {},
  ) {
    if (this.workers.has(sourceId))
      return Promise.reject(busy('This stream already has a worker.'));
    if (this.workers.size >= this.maxWorkers)
      return Promise.reject(busy('Media capacity reached.'));
    const child = this.launch();
    const active = {
      id: sourceId,
      video,
      child,
      stderr: '',
      stopping: false,
      exited: false,
      peers: new Map(),
      permission: null,
      lastKeyframeAt: -Infinity,
    };
    active.closed = new Promise((resolve) => (active.resolveClosed = resolve));
    const ready = new Promise((resolve, reject) => {
      active.resolveReady = resolve;
      active.rejectReady = reject;
    });
    this.workers.set(sourceId, active);
    child.stderr.on('data', (data) => {
      const text = String(data);
      active.stderr = (active.stderr + text).slice(-4096);
      // Native launch/driver failures are actionable setup diagnostics; keep
      // them visible in the host console instead of reducing them to 503.
      process.stderr.write(`[native-media ${sourceId}] ${text}`);
    });
    child.stdin.on('error', () => {});
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return; /* Non-protocol diagnostics must not become signaling. */
      }
      this.#message(active, message);
    });
    child.on('error', (error) => {
      active.rejectReady(error);
      for (const entry of active.peers.values())
        if (entry.state === 'negotiating') entry.fail(error);
    });
    child.on('close', () => {
      if (active.exited) return;
      active.exited = true;
      active.permission?.reject(new Error('Control worker exited'));
      clearTimeout(active.killTimer);
      lines.close();
      if (this.workers.get(sourceId) === active) this.workers.delete(sourceId);
      const error = new Error(active.stderr.trim() || 'Native media worker stopped.');
      active.rejectReady(error);
      for (const entry of active.peers.values()) {
        if (entry.state === 'negotiating') entry.fail(error);
        if (entry.state === 'removing') {
          clearTimeout(entry.timer);
          entry.resolveRemoved();
        }
      }
      active.peers.clear();
      active.resolveClosed();
      this.onExit(sourceId, { expected: active.stopping });
    });
    child.stdin.write(
      JSON.stringify({
        type: 'start',
        video,
        hostControl: this.hostControl,
        profile: video ? profile.name || 'desktop' : undefined,
        streamPlan:
          !video || profile.width === undefined
            ? undefined
            : {
                width: profile.width,
                height: profile.height,
                fps: profile.fps,
                bitrateKbps: profile.bitrateKbps,
                mtu: 1200,
                bitrateMode: profile.bitrateMode ?? DEFAULT_BITRATE_MODE,
                quality: profile.quality ?? DEFAULT_QUALITY,
              },
        display: (video && display) || undefined,
        // The host's encoder choice. Absent means automatic, which is also what the worker
        // assumes, so an audio-only source simply omits it.
        encoderBackend: video ? encoderBackend : undefined,
        audioFormat,
        codec: video ? codec : undefined,
      }) + '\n',
    );
    return ready;
  }
  #message(active, message) {
    const entry = typeof message.peerId === 'string' ? active.peers.get(message.peerId) : undefined;
    if (
      message.type === 'control-result' &&
      active.permission?.requestId === message.requestId &&
      typeof message.allowed === 'boolean'
    )
      active.permission.resolve(message.allowed);
    if (message.type === 'ready') {
      // The worker chooses its encoder once per stream, so this arrives once and then holds.
      if (typeof message.encoderBackend === 'string')
        active.encoder = {
          backend: message.encoderBackend,
          label: message.encoderLabel ?? message.encoderBackend,
          element: message.encoder ?? null,
          reason: message.encoderReason ?? null,
        };
      active.resolveReady();
    }
    if (
      message.type === 'answer' &&
      typeof message.sdp === 'string' &&
      entry?.state === 'negotiating'
    )
      entry.succeed(message.sdp);
    if (message.type === 'peer-failed') {
      const reason = typeof message.reason === 'string' ? message.reason : 'WebRTC peer failed.';
      if (entry?.state === 'negotiating') entry.fail(new Error(reason));
      else if (entry?.state === 'live') {
        active.peers.delete(message.peerId);
        // A legacy worker serves exactly one peer, so its failure ends the worker.
        if (active.recovery) this.stop(active.id);
        else this.onPeerFailed(active.id, message.peerId, reason);
      }
      // A removing peer completes on peer-closed.
    }
    if (message.type === 'peer-closed' && entry?.state === 'removing') {
      clearTimeout(entry.timer);
      active.peers.delete(message.peerId);
      entry.resolveRemoved();
    }
    if (message.type === 'metrics') {
      active.diagnostics?.record('server', peerSample(message, active.id));
      this.onMetrics(active.id, message);
    }
  }
  // Which encoder this source actually got, as the worker reported it at `ready`. Null before
  // the worker is ready, for an audio-only source, or for a worker too old to report it.
  encoder(sourceId) {
    return this.workers.get(sourceId)?.encoder ?? null;
  }
  addPeer(sourceId, peerId, sdp) {
    const active = this.workers.get(sourceId);
    if (!active || active.stopping || !active.child.stdin.writable)
      return Promise.reject(new Error('Native media worker stopped.'));
    if (active.peers.has(peerId)) return Promise.reject(busy('This stream already has a peer.'));
    return new Promise((resolve, reject) => {
      const entry = { state: 'negotiating' };
      const settle = (callback, value) => {
        if (entry.state !== 'negotiating') return;
        clearTimeout(entry.timer);
        callback(value);
      };
      entry.succeed = (answer) => {
        settle(resolve, answer);
        entry.state = 'live';
      };
      entry.fail = (error) => {
        if (entry.state !== 'negotiating') return;
        if (active.peers.get(peerId) === entry) active.peers.delete(peerId);
        settle(reject, error);
        entry.state = 'failed';
      };
      entry.timer = setTimeout(() => {
        entry.fail(new Error('WebRTC negotiation timed out.'));
        this.removePeer(sourceId, peerId).catch(() => {});
      }, this.negotiationTimeoutMs);
      active.peers.set(peerId, entry);
      active.child.stdin.write(JSON.stringify({ type: 'add-peer', peerId, sdp }) + '\n');
    });
  }
  removePeer(sourceId, peerId) {
    const active = this.workers.get(sourceId);
    if (!active) return Promise.resolve();
    if (active.stopping) return active.closed;
    const current = active.peers.get(peerId);
    if (current?.state === 'removing') return current.removed;
    current?.fail(new Error('Peer removed'));
    const entry = { state: 'removing' };
    entry.removed = new Promise((resolve) => (entry.resolveRemoved = resolve));
    // Without an acknowledgement the peer may still be sending; stopping the source is the
    // fail-closed alternative.
    entry.timer = setTimeout(() => {
      this.stop(sourceId).then(() => entry.resolveRemoved());
    }, this.removalTimeoutMs);
    active.peers.set(peerId, entry);
    active.child.stdin.write(JSON.stringify({ type: 'remove-peer', peerId }) + '\n');
    return entry.removed;
  }
  stop(id) {
    const active = this.workers.get(id);
    if (!active) return Promise.resolve();
    if (active.stopping) return active.closed;
    active.stopping = true;
    if (!active.child.stdin.destroyed)
      active.child.stdin.end(JSON.stringify({ type: 'stop' }) + '\n');
    // Keep the fallback timer alive until the OS confirms process exit.
    active.killTimer = setTimeout(() => active.child.kill(), 3000);
    return active.closed;
  }
  shutdown() {
    return Promise.all([...this.workers.keys()].map((id) => this.stop(id)));
  }
  setPermission(sourceId, peerId, allowed) {
    const active = this.workers.get(sourceId);
    if (!this.hostControl || !active || active.stopping || !active.child.stdin.writable)
      return Promise.reject(new Error('Inactive control worker'));
    if (active.permission) return Promise.reject(new Error('Control change already pending'));
    return new Promise((resolve, reject) => {
      const requestId = ++this.permissionSequence;
      const finish = (callback, value) => {
        clearTimeout(timer);
        active.permission = null;
        callback(value);
      };
      const timer = setTimeout(
        () => finish(reject, new Error('Control acknowledgement timed out')),
        1500,
      );
      active.permission = {
        requestId,
        resolve: (value) => finish(resolve, value),
        reject: (error) => finish(reject, error),
      };
      active.child.stdin.write(
        JSON.stringify({
          type: 'control-permission',
          peerId,
          requestId,
          allowed: allowed === true,
          leaseMs: 5000,
        }) + '\n',
        (error) => {
          if (error && active.permission?.requestId === requestId) active.permission.reject(error);
        },
      );
    });
  }
  // Recovery keyframes are limited per source, however many viewers request them.
  keyframe(sourceId) {
    const active = this.workers.get(sourceId);
    if (!active || active.stopping || !active.child.stdin.writable) return false;
    const now = Date.now();
    if (now - active.lastKeyframeAt < 2000) return false;
    active.lastKeyframeAt = now;
    active.child.stdin.write('{"type":"keyframe"}\n');
    return true;
  }
  // Legacy single-peer route: one worker per offer, with worker-owned diagnostics and recovery.
  offer(
    id,
    sdp,
    profile = { name: 'desktop' },
    audio = { mode: 'on' },
    display = null,
    { video = true } = {},
  ) {
    const existing = this.workers.get(id);
    const started = this.start(id, {
      video,
      profile,
      display,
      audioFormat:
        audio?.mode === 'off' ? undefined : profile.fps === 15 ? 'mono-32k' : 'stereo-96k',
    });
    const active = this.workers.get(id);
    if (!active || active === existing) return started;
    active.diagnostics =
      this.maxWorkers === 1 && this.diagnostics ? this.diagnostics : new Diagnostics();
    active.diagnostics.startStream(profile, audio, display);
    active.recovery = new Recovery();
    return (async () => {
      try {
        await started;
        return await this.addPeer(id, id, sdp);
      } catch (error) {
        await this.stop(id);
        throw error;
      }
    })();
  }
  receiverFeedback(id, sample) {
    const active = this.workers.get(id);
    if (!active?.recovery || active.stopping) return;
    if (active.recovery.observe(sample, Date.now())) this.keyframe(id);
  }
}
