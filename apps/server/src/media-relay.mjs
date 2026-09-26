import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Starts and supervises the media relay process (media-relay/main.mjs), which owns the one
// public UDP media port and forwards only authenticated clients to the workers' loopback-only
// ICE sockets (design: docs/superpowers/specs/2026-09-26-r4-media-relay-and-privilege-split-
// design.md, Part A). Every stream depends on it: when it exits, the caller stops every
// stream, and it is restarted at most three times a minute before media is reported as
// unavailable.

const RELAY_SCRIPT = fileURLToPath(new URL('./media-relay/main.mjs', import.meta.url));
const UNAUTHENTICATED = ['budget', 'malformed', 'unknown-ufrag', 'bad-integrity', 'username'];

export const RELAY_RESTARTS = Object.freeze({ limit: 3, windowMs: 60_000 });

export class MediaRelay {
  #launch;
  #port;
  #log;
  #now;
  #allowTimeoutMs;
  #startTimeoutMs;
  #child = null;
  #pending = new Map();
  #restarts = [];
  #stopping = false;
  #lastSummary = { at: -Infinity, dropped: 0 };
  state = 'stopped';
  reason = null;
  port = null;
  families = [];
  metrics = null;

  constructor({
    port,
    log = () => {},
    now = () => Date.now(),
    allowTimeoutMs = 5000,
    startTimeoutMs = 5000,
    onEvent = () => {},
    onExit = () => {},
    launch = () =>
      spawn(process.execPath, [RELAY_SCRIPT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      }),
  }) {
    this.#port = port;
    this.#log = log;
    this.#now = now;
    this.#allowTimeoutMs = allowTimeoutMs;
    this.#startTimeoutMs = startTimeoutMs;
    this.#launch = launch;
    this.onEvent = onEvent;
    this.onExit = onExit;
  }

  get listening() {
    return this.state === 'listening';
  }

  status() {
    return {
      state: this.state,
      port: this.port,
      families: [...this.families],
      reason: this.reason,
      metrics: this.metrics,
    };
  }

  // Resolves once the relay listens, or once it is known to be unavailable (never rejects:
  // sign-in works without media, and the reason is in `status()`).
  async start() {
    this.#stopping = false;
    const port = this.#port();
    this.port = port;
    this.state = 'starting';
    this.reason = null;
    const child = this.#launch();
    this.#child = child;
    let stderr = '';
    child.stderr?.on('data', (data) => (stderr = (stderr + String(data)).slice(-2048)));
    const started = new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#unavailable(`the media relay did not start within ${this.#startTimeoutMs} ms`);
        child.kill?.();
        resolve();
      }, this.#startTimeoutMs);
      this.#onStarted = (message) => {
        clearTimeout(timer);
        if (message.type === 'ready') {
          this.state = 'listening';
          this.families = message.families;
          this.#log(
            `Media relay listening on UDP ${message.port} (${message.families.join(', ')}).`,
          );
        } else
          this.#unavailable(
            message.code === 'EADDRINUSE'
              ? `UDP ${port} is in use by another program. Choose another media port.`
              : message.code === 'EACCES'
                ? `UDP ${port} cannot be used (access denied). Choose another media port.`
                : `the media relay could not listen on UDP ${port}: ${message.message}`,
          );
        resolve();
      };
      this.#onEarlyExit = () => {
        clearTimeout(timer);
        this.#unavailable(
          `the media relay stopped while starting${stderr ? `: ${stderr.trim()}` : ''}`,
        );
        resolve();
      };
    });
    this.#attach(child);
    child.stdin.write(`${JSON.stringify({ type: 'start', port })}\n`);
    await started;
  }

  #onStarted = () => {};
  #onEarlyExit = () => {};

  #unavailable(reason) {
    this.state = 'unavailable';
    this.reason = reason;
    this.#log(`Media is unavailable: ${reason}`);
  }

  #attach(child) {
    let buffered = '';
    child.stdout.on('data', (data) => {
      buffered += String(data);
      let newline;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (child === this.#child) this.#message(message);
      }
    });
    child.stdin.on?.('error', () => {});
    child.on('exit', (code, signal) => {
      if (child !== this.#child) return;
      this.#child = null;
      for (const [, pending] of this.#pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error('The media relay stopped'));
      }
      this.#pending.clear();
      if (this.state === 'starting') return this.#onEarlyExit();
      if (this.#stopping) {
        this.state = 'stopped';
        return;
      }
      const wasListening = this.state === 'listening';
      this.#log(`Media relay exited (${signal ?? `code ${code}`}); every stream stopped.`);
      this.onExit();
      if (!wasListening) return;
      const now = this.#now();
      this.#restarts = this.#restarts.filter((at) => now - at < RELAY_RESTARTS.windowMs);
      if (this.#restarts.length >= RELAY_RESTARTS.limit) {
        this.#unavailable('the media relay stopped repeatedly; restart VidVNC to try again');
        return;
      }
      this.#restarts.push(now);
      this.start();
    });
  }

  #message(message) {
    switch (message?.type) {
      case 'ready':
      case 'failed':
        return this.#onStarted(message);
      case 'allowed':
      case 'refused': {
        const pending = this.#pending.get(message.streamId);
        if (!pending) return;
        this.#pending.delete(message.streamId);
        clearTimeout(pending.timer);
        if (message.type === 'allowed') pending.resolve();
        else pending.reject(new Error(`The media relay refused the stream: ${message.reason}`));
        return;
      }
      case 'metrics':
        this.metrics = {
          dropped: message.dropped,
          forwarded: message.forwarded,
          addressDiffers: message.addressDiffers,
          registrations: message.registrations,
          pins: message.pins,
        };
        return this.#summarise();
      case 'pinned':
        this.#log(
          `[relay ${message.streamId}] Media path authenticated from ${message.tuple}${message.hintMatched === false ? ' (differs from the HTTPS address)' : ''}.`,
        );
        return this.onEvent(message);
      case 'unpinned':
        this.#log(
          `[relay ${message.streamId}] Media path ${message.tuple} ended (${message.reason}).`,
        );
        return this.onEvent(message);
      case 'expired':
        this.#log(`[relay ${message.streamId}] No authenticated media within the time limit.`);
        return this.onEvent(message);
      case 'address-differs':
        return this.onEvent(message);
      default:
    }
  }

  // Once a minute at most: how many unauthenticated datagrams were dropped since the last
  // summary. Counts only; never packet contents or credentials.
  #summarise() {
    const now = this.#now();
    if (now - this.#lastSummary.at < 60_000) return;
    const dropped = UNAUTHENTICATED.reduce(
      (total, reason) => total + (this.metrics.dropped?.[reason] ?? 0),
      0,
    );
    const since = dropped - this.#lastSummary.dropped;
    if (since > 0) {
      const detail = UNAUTHENTICATED.filter((reason) => this.metrics.dropped?.[reason])
        .map((reason) => `${reason} ${this.metrics.dropped[reason]}`)
        .join(', ');
      this.#log(`Media relay dropped ${since} unauthenticated datagram(s) (totals: ${detail}).`);
    }
    this.#lastSummary = { at: now, dropped };
  }

  // Registers a stream and resolves once the relay has it; the answer must not reach the
  // client before this, or the client's first check would be dropped.
  allow(registration) {
    if (!this.listening || !this.#child)
      return Promise.reject(
        Object.assign(
          new Error(`Media is unavailable: ${this.reason ?? 'the relay is not running'}`),
          {
            status: 503,
          },
        ),
      );
    if (this.#pending.has(registration.streamId))
      return Promise.reject(new Error('Duplicate relay registration'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(registration.streamId);
        this.revoke(registration.streamId);
        reject(new Error('The media relay did not confirm the stream in time'));
      }, this.#allowTimeoutMs);
      this.#pending.set(registration.streamId, { resolve, reject, timer });
      this.#write({ type: 'allow', ...registration });
    });
  }

  revoke(streamId) {
    this.#write({ type: 'revoke', streamId });
  }

  #write(message) {
    if (!this.#child) return;
    try {
      this.#child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // The exit handler reports it.
    }
  }

  // Stops the relay; with `restart`, starts it again on the (possibly changed) port.
  async stop() {
    const child = this.#child;
    this.#stopping = true;
    if (!child) {
      this.state = 'stopped';
      return;
    }
    const exited = new Promise((resolve) => child.once('exit', resolve));
    this.#write({ type: 'stop' });
    child.stdin.end?.();
    const timer = setTimeout(() => child.kill?.(), 2000);
    await exited;
    clearTimeout(timer);
  }

  async restart() {
    await this.stop();
    this.onExit();
    this.#restarts = [];
    await this.start();
  }
}
