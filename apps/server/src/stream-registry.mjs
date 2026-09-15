import { randomUUID } from 'node:crypto';

// Lifecycle admission only; media ownership releases a slot after OS process exit.
export class StreamRegistry {
  #streams = new Map();
  constructor({
    maxStreams = 4,
    perSession = 2,
    bitrateKbps = 32000,
    pixelsPerSecond = 500_000_000,
  } = {}) {
    for (const value of [maxStreams, perSession, bitrateKbps, pixelsPerSecond])
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid stream limit');
    this.limits = Object.freeze({ maxStreams, perSession, bitrateKbps, pixelsPerSecond });
  }
  reserve(sessionId, plan) {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid stream owner');
    const profile = plan?.profile;
    if (
      !profile ||
      ['width', 'height', 'fps', 'bitrateKbps'].some(
        (key) => !Number.isSafeInteger(profile[key]) || profile[key] < 1,
      )
    )
      throw new Error('Invalid stream plan');
    const pixels = profile.width * profile.height * profile.fps;
    if (!Number.isSafeInteger(pixels)) throw new Error('Invalid stream plan');
    const rows = [...this.#streams.values()];
    if (
      rows.length >= this.limits.maxStreams ||
      rows.filter((s) => s.sessionId === sessionId).length >= this.limits.perSession
    )
      throw new Error('Stream capacity limit reached');
    if (
      rows.reduce((n, s) => n + s.plan.profile.bitrateKbps, profile.bitrateKbps) >
      this.limits.bitrateKbps
    )
      throw new Error('Host bitrate budget exceeded');
    if (rows.reduce((n, s) => n + s.pixels, pixels) > this.limits.pixelsPerSecond)
      throw new Error('Host pixel-rate budget exceeded');
    const stream = {
      id: randomUUID(),
      sessionId,
      state: 'starting',
      plan: structuredClone(plan),
      pixels,
    };
    this.#streams.set(stream.id, stream);
    return structuredClone(stream);
  }
  get(sessionId, id) {
    const stream = this.#streams.get(id);
    return stream?.sessionId === sessionId ? structuredClone(stream) : null;
  }
  list(sessionId) {
    return [...this.#streams.values()]
      .filter((s) => sessionId === undefined || s.sessionId === sessionId)
      .map((s) => structuredClone(s));
  }
  transition(sessionId, id, state) {
    const stream = this.#streams.get(id);
    if (
      stream?.sessionId !== sessionId ||
      !{ starting: ['live', 'closing'], live: ['closing'], closing: [] }[stream.state].includes(
        state,
      )
    )
      return false;
    stream.state = state;
    return true;
  }
  release(id) {
    return this.#streams.delete(id);
  }
}
