import { spawn, execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { executable, workerEnvironment } from '@vidvnc/media-worker/runtime';
import { Recovery } from './recovery.mjs';
import { Diagnostics } from './diagnostics.mjs';

export function probe() {
  return JSON.parse(
    execFileSync(executable, ['--probe'], {
      env: workerEnvironment(),
      windowsHide: true,
      timeout: 15000,
      encoding: 'utf8',
    }),
  );
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
export class NativeMedia {
  constructor({
    onExit = () => {},
    diagnostics = null,
    maxWorkers = 1,
    hostControl = false,
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
    this.workers = new Map();
    this.maxWorkers = maxWorkers;
    this.launch = launch;
    this.hostControl = hostControl;
    this.permissionSequence = 0;
    this.diagnostics = diagnostics;
  }
  // Compatibility for the single-stream host until its status contract migrates.
  get active() {
    return this.workers.values().next().value ?? null;
  }
  offer(
    id,
    sdp,
    profile = { name: 'desktop' },
    audio = { mode: 'on' },
    display = null,
    { video = true } = {},
  ) {
    if (this.workers.has(id))
      return Promise.reject(
        Object.assign(new Error('This stream already has a worker.'), { code: 'MEDIA_BUSY' }),
      );
    if (this.workers.size >= this.maxWorkers)
      return Promise.reject(
        Object.assign(new Error('Media capacity reached.'), { code: 'MEDIA_BUSY' }),
      );
    return new Promise((resolve, reject) => {
      const child = this.launch();
      const active = {
        id,
        video,
        child,
        stderr: '',
        stopping: false,
        recovery: new Recovery(),
        diagnostics:
          this.maxWorkers === 1 && this.diagnostics ? this.diagnostics : new Diagnostics(),
      };
      active.closed = new Promise((resolve) => {
        active.resolveClosed = resolve;
      });
      this.workers.set(id, active);
      active.diagnostics.startStream(profile, audio, display);
      const timer = setTimeout(() => {
        reject(new Error('WebRTC negotiation timed out.'));
        this.stop(id);
      }, 15000);
      child.stderr.on('data', (data) => {
        const text = String(data);
        active.stderr = (active.stderr + text).slice(-4096);
        // Native launch/driver failures are actionable setup diagnostics; keep
        // them visible in the host console instead of reducing them to 503.
        process.stderr.write(`[native-media ${id}] ${text}`);
      });
      child.stdin.on('error', () => {});
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        try {
          const message = JSON.parse(line);
          if (
            message.type === 'control-result' &&
            active.permission?.requestId === message.requestId &&
            typeof message.allowed === 'boolean'
          ) {
            active.permission.resolve(message.allowed);
          }
          if (message.type === 'metrics') active.diagnostics.record('server', message);
          if (message.type === 'answer' && typeof message.sdp === 'string') {
            clearTimeout(timer);
            resolve(message.sdp);
          }
        } catch {
          /* Non-protocol diagnostics must not become signaling. */
        }
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', () => {
        active.permission?.reject(new Error('Control worker exited'));
        clearTimeout(timer);
        clearTimeout(active.killTimer);
        lines.close();
        if (this.workers.get(id) === active) this.workers.delete(id);
        active.resolveClosed();
        reject(new Error(active.stderr.trim() || 'Native media worker stopped.'));
        this.onExit(id, { expected: active.stopping });
      });
      child.stdin.write(
        JSON.stringify({
          type: 'offer',
          video,
          sdp,
          profile: profile.name || 'desktop',
          streamPlan:
            profile.width === undefined
              ? undefined
              : {
                  width: profile.width,
                  height: profile.height,
                  fps: profile.fps,
                  bitrateKbps: profile.bitrateKbps,
                  mtu: 1200,
                },
          audio: audio.mode || 'on',
          hostControl: this.hostControl,
          display: display ?? undefined,
        }) + '\n',
      );
    });
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
  setPermission(id, allowed) {
    const active = this.workers.get(id);
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
  receiverFeedback(id, sample) {
    const active = this.workers.get(id);
    if (!active || active.stopping || !active.child.stdin.writable) return;
    if (active.recovery.observe(sample, Date.now()))
      active.child.stdin.write('{"type":"keyframe"}\n');
  }
}
