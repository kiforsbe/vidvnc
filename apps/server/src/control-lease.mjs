// Host-only coordinator. A client request never calls grant directly.
export class ControlLease {
  #owner = null;
  #tail = Promise.resolve();
  #pending = 0;
  constructor({ media, isActive }) {
    this.media = media;
    this.isActive = isActive;
  }
  get owner() {
    return this.#owner
      ? { sessionId: this.#owner.sessionId, streamId: this.#owner.streamId }
      : null;
  }
  get explicitOwner() {
    return this.#owner?.explicitOwner === true;
  }
  #serialize(operation) {
    this.#pending++;
    const result = this.#tail.then(operation).finally(() => this.#pending--);
    this.#tail = result.catch(() => {});
    return result;
  }
  async #release() {
    const previous = this.#owner;
    this.#owner = null;
    if (!previous) return { nativeAck: true, peerTerminated: false };
    try {
      if ((await this.media.setPermission(previous.streamId, false)) !== false)
        throw new Error('Worker refused control revoke');
      return { nativeAck: true, peerTerminated: false };
    } catch {
      // Peer removal acknowledgement, or the source's OS-confirmed exit when removal is not
      // acknowledged, is the fail-closed alternative to release acknowledgement.
      await this.media.removePeer(previous.streamId);
      return { nativeAck: false, peerTerminated: true };
    }
  }
  grant(sessionId, streamId, { onlyIfAvailable = false, explicitOwner = false } = {}) {
    if (onlyIfAvailable && (this.#pending || this.#owner)) return Promise.resolve(false);
    if (this.#pending) return Promise.reject(new Error('Control change already pending'));
    return this.#serialize(async () => {
      if (onlyIfAvailable && this.#owner) return false;
      if (!this.isActive(sessionId, streamId, { explicitOwner }))
        throw new Error('Inactive control target');
      await this.#release();
      if (!this.isActive(sessionId, streamId, { explicitOwner }))
        throw new Error('Inactive control target');
      try {
        if ((await this.media.setPermission(streamId, true)) !== true)
          throw new Error('Worker refused control grant');
        this.#owner = { sessionId, streamId, explicitOwner };
        if (!this.isActive(sessionId, streamId, { explicitOwner })) {
          await this.#release();
          throw new Error('Inactive control target');
        }
      } catch (error) {
        await this.media.removePeer(streamId);
        throw error;
      }
    });
  }
  revoke(sessionId) {
    return this.#serialize(async () => {
      if (sessionId === undefined || this.#owner?.sessionId === sessionId) return this.#release();
      return { nativeAck: true, peerTerminated: false };
    });
  }
  renew() {
    if (this.#pending) return Promise.resolve();
    return this.#serialize(async () => {
      const owner = this.#owner;
      if (!owner) return;
      if (!this.isActive(owner.sessionId, owner.streamId, { explicitOwner: owner.explicitOwner }))
        return this.#release();
      try {
        if ((await this.media.setPermission(owner.streamId, true)) !== true)
          throw new Error('Worker refused control renewal');
        if (!this.isActive(owner.sessionId, owner.streamId, { explicitOwner: owner.explicitOwner }))
          await this.#release();
      } catch {
        await this.#release();
      }
    });
  }
}
