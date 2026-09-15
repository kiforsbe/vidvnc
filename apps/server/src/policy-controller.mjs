export class PolicyController {
  #store;
  #sessions;
  #media;
  busy = false;
  constructor(store, sessions, media) {
    this.#store = store;
    this.#sessions = sessions;
    this.#media = media;
  }
  snapshot() {
    return this.#store.snapshot();
  }
  async replace(candidate, revision, disconnect = false) {
    if (this.busy) throw new Error('A configuration change is already in progress');
    if (this.#sessions.list().length && disconnect !== true)
      throw new Error('Confirm disconnecting connected clients before applying changes');
    this.busy = true;
    try {
      const result = await this.#store.replace(candidate, revision);
      for (const session of this.#sessions.list()) this.#sessions.disconnect(session.sessionId);
      await this.#media.shutdown();
      return result;
    } finally {
      this.busy = false;
    }
  }
}
