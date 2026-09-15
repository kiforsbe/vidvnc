import { randomUUID } from 'node:crypto';

const AUDIO_FORMATS = ['mono-32k', 'stereo-96k'];
const SUBSCRIPTION_STATES = { starting: ['live', 'closing'], live: ['closing'], closing: [] };

// Audio follows the session profile: the 15 fps mobile profiles get the low-bandwidth mix.
export function audioFormat(profile) {
  return profile?.fps === 15 ? 'mono-32k' : 'stereo-96k';
}

// Everything that changes captured or encoded bytes, and nothing else: profile names and ids
// never participate, so differently named but identical profiles share one encode.
export function sourceKey(plan) {
  if (plan.kind === 'audio') return `audio|${plan.format}`;
  const { profile, display = {}, revision } = plan;
  return [
    'video',
    revision,
    display.id,
    [display.x, display.y, display.width, display.height, display.rotation].join(','),
    `${profile.width}x${profile.height}@${profile.fps}`,
    profile.bitrateKbps,
  ].join('|');
}

// Admission for shared sources (one worker each) and the per-client subscriptions on them.
// Budgets are released only after the source's OS process exits.
export class StreamRegistry {
  #sources = new Map();
  #subscriptions = new Map();
  constructor({
    maxStreams = 8,
    perSession = 2,
    bitrateKbps = 32000,
    pixelsPerSecond = 500_000_000,
  } = {}) {
    for (const value of [maxStreams, perSession, bitrateKbps, pixelsPerSecond])
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid stream limit');
    this.limits = Object.freeze({ maxStreams, perSession, bitrateKbps, pixelsPerSecond });
  }
  subscribe(sessionId, plan) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid stream owner');
    const kind = plan?.kind === 'audio' ? 'audio' : 'video';
    let pixels = 0;
    if (kind === 'audio') {
      if (!AUDIO_FORMATS.includes(plan.format)) throw new Error('Invalid stream plan');
    } else {
      const profile = plan?.profile;
      if (
        !profile ||
        ['width', 'height', 'fps', 'bitrateKbps'].some(
          (key) => !Number.isSafeInteger(profile[key]) || profile[key] < 1,
        )
      )
        throw new Error('Invalid stream plan');
      pixels = profile.width * profile.height * profile.fps;
      if (!Number.isSafeInteger(pixels)) throw new Error('Invalid stream plan');
    }
    const owned = [...this.#subscriptions.values()].filter(
      (s) => s.sessionId === sessionId && s.kind === kind,
    );
    if (kind === 'audio' && owned.length) throw new Error('Session audio already active');
    if (kind === 'video' && owned.length >= this.limits.perSession)
      throw new Error('Stream capacity limit reached');
    const key = sourceKey(plan);
    let source = [...this.#sources.values()].find((s) => s.key === key && s.state !== 'closing');
    const created = !source;
    if (created) {
      if (kind === 'video') {
        const video = [...this.#sources.values()].filter((s) => s.kind === 'video');
        if (video.length >= this.limits.maxStreams)
          throw new Error('Stream capacity limit reached');
        if (
          video.reduce((n, s) => n + s.plan.profile.bitrateKbps, plan.profile.bitrateKbps) >
          this.limits.bitrateKbps
        )
          throw new Error('Host bitrate budget exceeded');
        if (video.reduce((n, s) => n + s.pixels, pixels) > this.limits.pixelsPerSecond)
          throw new Error('Host pixel-rate budget exceeded');
      }
      source = {
        id: randomUUID(),
        kind,
        key,
        plan: structuredClone(plan),
        pixels,
        state: 'starting',
        subscriptions: [],
      };
      this.#sources.set(source.id, source);
    }
    const stream = {
      id: randomUUID(),
      sessionId,
      sourceId: source.id,
      kind,
      state: 'starting',
      plan: structuredClone(plan),
    };
    this.#subscriptions.set(stream.id, stream);
    source.subscriptions.push(stream.id);
    return { stream: structuredClone(stream), source: structuredClone(source), created };
  }
  unsubscribe(streamId) {
    const stream = this.#subscriptions.get(streamId);
    if (!stream) return { source: null, last: false };
    this.#subscriptions.delete(streamId);
    const source = this.#sources.get(stream.sourceId);
    if (!source) return { source: null, last: false };
    source.subscriptions = source.subscriptions.filter((id) => id !== streamId);
    const last = !source.subscriptions.length && source.state !== 'closing';
    if (last) source.state = 'closing';
    return { source: structuredClone(source), last };
  }
  markReady(sourceId) {
    const source = this.#sources.get(sourceId);
    if (source?.state !== 'starting') return false;
    source.state = 'ready';
    return true;
  }
  closeSource(sourceId) {
    const source = this.#sources.get(sourceId);
    if (!source) return false;
    source.state = 'closing';
    for (const id of source.subscriptions) this.#subscriptions.get(id).state = 'closing';
    return true;
  }
  releaseSource(sourceId) {
    const source = this.#sources.get(sourceId);
    if (!source) return false;
    for (const id of source.subscriptions) this.#subscriptions.delete(id);
    return this.#sources.delete(sourceId);
  }
  source(sourceId) {
    const source = this.#sources.get(sourceId);
    return source ? structuredClone(source) : null;
  }
  sourceOf(streamId) {
    return this.source(this.#subscriptions.get(streamId)?.sourceId);
  }
  sources() {
    return [...this.#sources.values()].map((s) => structuredClone(s));
  }
  // Unscoped lookup for runtime bookkeeping; client routes use get().
  subscription(streamId) {
    const stream = this.#subscriptions.get(streamId);
    return stream ? structuredClone(stream) : null;
  }
  get(sessionId, id) {
    const stream = this.#subscriptions.get(id);
    return stream?.sessionId === sessionId && stream.kind === 'video'
      ? structuredClone(stream)
      : null;
  }
  list(sessionId, kind = 'video') {
    return [...this.#subscriptions.values()]
      .filter((s) => s.kind === kind && (sessionId === undefined || s.sessionId === sessionId))
      .map((s) => structuredClone(s));
  }
  transition(sessionId, id, state) {
    const stream = this.#subscriptions.get(id);
    if (stream?.sessionId !== sessionId || !SUBSCRIPTION_STATES[stream.state].includes(state))
      return false;
    stream.state = state;
    return true;
  }
}
