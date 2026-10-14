// Latency measurements started from Diagnostics and run by a viewer. One at a time per server,
// held in memory only. Timeouts and ended streams are settled lazily by every method, so no
// timer runs. See docs/superpowers/specs/2026-10-14-latency-probe-from-diagnostics-design.md.

import { randomBytes } from 'node:crypto';
import { LATENCY_REASONS, validateLatencyResults } from './latency-results.mjs';

const PICKUP_TIMEOUT_MS = 15_000;
const RUN_TIMEOUT_MS = 120_000;
const HISTORY = 5;

function invalidReport() {
  return new Error('Invalid latency report');
}

export class LatencyProbes {
  #isLive;
  #now;
  #randomId;
  #active = null;
  #history = new Map();

  constructor({ isLive, now = Date.now, randomId = () => randomBytes(16).toString('base64url') }) {
    this.#isLive = isLive;
    this.#now = now;
    this.#randomId = randomId;
  }

  request(streamId, sessionId) {
    this.#settle();
    if (this.#active)
      throw Object.assign(new Error('A measurement is already running'), { code: 'busy' });
    this.#active = {
      id: this.#randomId(),
      streamId,
      sessionId,
      state: 'requested',
      reason: null,
      requestedAt: this.#now(),
      runningAt: null,
      endedAt: null,
      results: null,
      pickedUp: false,
    };
    return { id: this.#active.id, state: 'requested' };
  }

  pickup(sessionId, streamId) {
    this.#settle();
    const active = this.#active;
    if (
      !active ||
      active.state !== 'requested' ||
      active.pickedUp ||
      active.sessionId !== sessionId ||
      active.streamId !== streamId
    )
      return null;
    active.pickedUp = true;
    return { id: active.id };
  }

  report(sessionId, { streamId, id, state, reason, results } = {}) {
    this.#settle();
    const active = this.#active;
    if (
      !active ||
      active.id !== id ||
      active.sessionId !== sessionId ||
      active.streamId !== streamId
    )
      return false;
    try {
      if (
        state === 'running' &&
        active.state === 'requested' &&
        reason === undefined &&
        results === undefined
      ) {
        active.state = 'running';
        active.runningAt = this.#now();
      } else if (state === 'failed' && LATENCY_REASONS.includes(reason) && results === undefined) {
        this.#finish('failed', reason);
      } else if (state === 'done' && active.state === 'running' && reason === undefined) {
        this.#finish('done', null, validateLatencyResults(results));
      } else {
        throw invalidReport();
      }
    } catch {
      this.#finish('failed', 'invalid-report');
      throw invalidReport();
    }
    return true;
  }

  allowsAsset(sessionId) {
    this.#settle();
    return this.#active?.sessionId === sessionId;
  }

  snapshot(streamId) {
    this.#settle();
    const active = this.#active?.streamId === streamId ? view(this.#active) : null;
    return { active, history: (this.#history.get(streamId) ?? []).map(view) };
  }

  #settle() {
    const active = this.#active;
    if (!active) return;
    const now = this.#now();
    if (!this.#isLive(active.sessionId, active.streamId)) this.#finish('failed', 'ended');
    else if (active.state === 'requested' && now - active.requestedAt > PICKUP_TIMEOUT_MS)
      this.#finish('failed', 'expired');
    else if (active.state === 'running' && now - active.runningAt > RUN_TIMEOUT_MS)
      this.#finish('failed', 'expired');
  }

  #finish(state, reason, results = null) {
    const active = this.#active;
    Object.assign(active, { state, reason, results, endedAt: this.#now() });
    this.#active = null;
    const history = this.#history.get(active.streamId) ?? [];
    history.unshift(active);
    history.length = Math.min(history.length, HISTORY);
    this.#history.set(active.streamId, history);
  }
}

function view({ id, state, reason, requestedAt, endedAt, results }) {
  return { id, state, reason, requestedAt, endedAt, results };
}
