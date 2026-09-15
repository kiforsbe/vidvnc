import { StreamRegistry } from './stream-registry.mjs';
import { ControlLease } from './control-lease.mjs';
import { resolveStreamPolicy } from './stream-policy.mjs';
import { randomUUID } from 'node:crypto';
import { hostStatus } from './host-status.mjs';

export class StreamRuntime {
  constructor({
    sessions,
    media,
    inventory,
    policy,
    access,
    approvedClients,
    registry = new StreamRegistry(),
    clock = Date.now,
  }) {
    Object.assign(this, { sessions, media, inventory, policy, approvedClients, registry, clock });
    this.stopping = false;
    this.sessionStops = new Map();
    this.telemetryTimes = new Map();
    this.audio = new Map();
    this.selected = new Map();
    this.automaticControl = new Set();
    const onConnect = sessions.onConnect;
    sessions.onConnect = (id) => {
      onConnect?.(id);
      const approvedClientId = sessions.get(id)?.approvedClientId;
      const permission = approvedClientId ? approvedClients?.permission(approvedClientId) : null;
      const control =
        permission && permission !== 'default' ? permission : access?.snapshot().defaultControl;
      if (control === 'available') this.automaticControl.add(id);
    };
    this.control = new ControlLease({
      media,
      isActive: (sessionId, streamId) =>
        sessions.list().some((s) => s.sessionId === sessionId) &&
        registry.get(sessionId, streamId)?.state === 'live' &&
        media.workers.has(streamId),
    });
    const onExit = media.onExit;
    media.onExit = (id, exit) => {
      for (const [sessionId, streamId] of this.selected)
        if (streamId === id) this.selected.delete(sessionId);
      registry.release(id);
      this.telemetryTimes.delete(id);
      for (const [sessionId, audio] of this.audio)
        if (audio.id === id) this.audio.delete(sessionId);
      onExit?.(id, exit);
    };
    const onRevoke = sessions.onRevoke;
    sessions.onRevoke = (id) => {
      this.automaticControl.delete(id);
      this.selected.delete(id);
      onRevoke(id);
      this.stopSession(id).catch((error) =>
        console.error('Session cleanup failed:', error.message),
      );
    };
  }
  list(sessionId) {
    return this.registry
      .list(sessionId)
      .map(({ id, state, plan }) => ({ streamId: id, state, ...plan }));
  }
  async selectStream(sessionId, streamId) {
    if (!this.sessions.get(sessionId) || this.registry.get(sessionId, streamId)?.state !== 'live')
      throw Object.assign(new Error('Unknown stream'), { status: 404 });
    if (this.control.owner?.sessionId === sessionId && this.control.owner.streamId !== streamId)
      await this.control.grant(sessionId, streamId);
    else if (this.automaticControl.delete(sessionId))
      await this.control.grant(sessionId, streamId, { onlyIfAvailable: true });
    if (this.registry.get(sessionId, streamId)?.state !== 'live') throw new Error('Stream ended');
    this.selected.set(sessionId, streamId);
    return {
      controlStreamId:
        this.control.owner?.sessionId === sessionId ? this.control.owner.streamId : null,
    };
  }
  // Called only by the local owner command pipe, never by an HTTP admin route.
  async command({ action, sessionId, streamId }) {
    if (!this.sessions.list().some((session) => session.sessionId === sessionId))
      throw new Error('Device disconnected');
    if (action === 'grant' || action === 'revoke') this.automaticControl.delete(sessionId);
    if (action === 'grant' && this.#viewOnly(sessionId))
      throw new Error('This approved client is set to view only');
    if (action === 'grant') return this.control.grant(sessionId, this.selected.get(sessionId));
    if (action === 'revoke') return this.control.revoke(sessionId);
    if (action === 'stop-stream') return this.stopStream(sessionId, streamId);
    throw new Error('Unknown session action');
  }
  #viewOnly(sessionId) {
    const approvedClientId = this.sessions.get(sessionId)?.approvedClientId;
    return !!approvedClientId && this.approvedClients?.permission(approvedClientId) === 'view-only';
  }
  status() {
    const owner = this.control.owner;
    const sessions = this.sessions.list().map((session) => {
      const row = hostStatus([session], null).sessions[0];
      row.control = owner?.sessionId === session.sessionId ? 'Granted' : 'View only';
      row.controlStreamId = owner?.sessionId === session.sessionId ? owner.streamId : null;
      row.selectedStreamId = this.selected.get(session.sessionId) ?? null;
      row.audio = this.audio.get(session.sessionId)?.state === 'live';
      const health = [];
      row.streams = this.registry.list(session.sessionId).map((stream) => {
        const metrics = this.media.workers.get(stream.id)?.diagnostics.snapshot() ?? {};
        const derived = hostStatus([{ ...session, ...stream.plan }], session.sessionId, metrics)
          .sessions[0];
        health.push(derived.health);
        return { ...derived.streams[0], id: stream.id, state: stream.state };
      });
      row.health =
        health.find((value) => value !== 'Smooth') ??
        (health.length ? 'Smooth' : 'No active streams');
      return row;
    });
    return {
      type: 'status',
      sessions,
      streamCount: sessions.reduce((count, row) => count + row.streams.length, 0),
      capabilities: {
        maxSessions: this.sessions.maxSessions,
        maxStreamsPerSession: this.registry.limits.perSession,
        primaryDisplayOnly: false,
        hostControl: true,
      },
    };
  }
  diagnosticStreams() {
    return this.status().sessions.flatMap((session) =>
      session.streams.map((stream) => ({
        id: stream.id,
        label: `${session.device} · ${session.address} · ${stream.name}`,
        state: stream.state,
      })),
    );
  }
  diagnostics(streamId) {
    const stream = this.registry.list().find((stream) => stream.id === streamId);
    const metrics = this.media.workers.get(streamId)?.diagnostics.snapshot();
    if (!stream || !metrics) return null;
    const audio = this.audio.get(stream.sessionId);
    return {
      ...metrics,
      sessionAudio: this.media.workers.get(audio?.id)?.diagnostics.snapshot() ?? null,
    };
  }
  valid(stream) {
    const policy = this.policy.snapshot();
    if (policy.revision !== stream.plan.revision || this.policy.busy) return false;
    try {
      const current = this.inventory.select(policy, stream.plan.display.id);
      return ['id', 'x', 'y', 'width', 'height', 'rotation'].every(
        (key) => current[key] === stream.plan.display[key],
      );
    } catch {
      return false;
    }
  }
  async offerVideo(sessionId, request) {
    const session = this.sessions.get(sessionId);
    if (!session || this.stopping || this.sessionStops.has(sessionId))
      throw new Error('Inactive session');
    if (
      typeof request.sdp !== 'string' ||
      !request.sdp.startsWith('v=0') ||
      request.sdp.length > 65536
    )
      throw new Error('Invalid SDP');
    if (this.policy.busy)
      throw Object.assign(new Error('Host settings are being applied'), { status: 409 });
    const policy = this.policy.snapshot();
    let display, effective, stream;
    try {
      display = this.inventory.select(policy, request.displayId, request.inventoryRevision);
      effective = resolveStreamPolicy(policy, {
        profileId: request.profile ?? 'auto',
        displayId: display.id,
        userAgent: session.device === 'iPhone' ? 'iPhone' : '',
        audio: false,
      });
    } catch (error) {
      throw Object.assign(error, { status: 403 });
    }
    try {
      stream = this.registry.reserve(sessionId, {
        profile: effective.profile,
        display,
        revision: effective.revision,
        audio: { mode: 'off', enabled: false },
      });
    } catch (error) {
      throw Object.assign(error, { status: 409 });
    }
    try {
      const sdp = await this.media.offer(
        stream.id,
        request.sdp,
        stream.plan.profile,
        stream.plan.audio,
        display,
      );
      if (
        !this.sessions.get(sessionId) ||
        this.stopping ||
        !this.valid(stream) ||
        !this.registry.transition(sessionId, stream.id, 'live')
      )
        throw new Error('Stream ended during negotiation');
      return { streamId: stream.id, type: 'answer', sdp, profile: stream.plan.profile, display };
    } catch (error) {
      await this.media.stop(stream.id);
      this.registry.release(stream.id);
      throw error;
    }
  }
  record(sessionId, streamId, sample) {
    const stream = this.registry.get(sessionId, streamId);
    const worker = this.media.workers.get(streamId);
    if (!stream || stream.state !== 'live' || !worker) return false;
    const now = this.clock();
    if (now - (this.telemetryTimes.get(streamId) ?? -Infinity) < 800) return false;
    this.telemetryTimes.set(streamId, now);
    worker.diagnostics.record('client', sample);
    this.media.receiverFeedback(streamId, sample);
    return true;
  }
  recordAudio(sessionId, streamId, sample) {
    const audio = this.audio.get(sessionId);
    const worker = this.media.workers.get(streamId);
    if (audio?.id !== streamId || audio?.state !== 'live' || !worker) return false;
    const now = this.clock();
    if (now - (this.telemetryTimes.get(streamId) ?? -Infinity) < 800) return false;
    this.telemetryTimes.set(streamId, now);
    return worker.diagnostics.record('client', sample);
  }
  async offerAudio(sessionId, sdp) {
    const session = this.sessions.get(sessionId);
    if (!session || this.stopping || this.sessionStops.has(sessionId))
      throw new Error('Inactive session');
    if (this.audio.has(sessionId))
      throw Object.assign(new Error('Session audio already active'), { status: 409 });
    if (!session.audio?.enabled || !this.policy.snapshot().allowAudio || this.policy.busy)
      throw Object.assign(new Error('Desktop audio is not allowed'), { status: 403 });
    if (typeof sdp !== 'string' || !sdp.startsWith('v=0') || sdp.length > 65536)
      throw new Error('Invalid SDP');
    const audio = { id: randomUUID(), state: 'starting' };
    this.audio.set(sessionId, audio);
    try {
      const answer = await this.media.offer(audio.id, sdp, session.profile, { mode: 'on' }, null, {
        video: false,
      });
      if (
        !this.sessions.get(sessionId) ||
        this.stopping ||
        this.audio.get(sessionId) !== audio ||
        !this.policy.snapshot().allowAudio
      )
        throw new Error('Session audio ended during negotiation');
      audio.state = 'live';
      return { streamId: audio.id, type: 'answer', sdp: answer };
    } catch (error) {
      await this.media.stop(audio.id);
      if (this.audio.get(sessionId) === audio) this.audio.delete(sessionId);
      throw error;
    }
  }
  async stopStream(sessionId, streamId) {
    if (!this.registry.get(sessionId, streamId)) throw new Error('Unknown stream');
    this.registry.transition(sessionId, streamId, 'closing');
    if (this.control.owner?.streamId === streamId) await this.control.revoke(sessionId);
    await this.media.stop(streamId);
    this.registry.release(streamId);
    this.telemetryTimes.delete(streamId);
  }
  stopSession(sessionId) {
    if (this.sessionStops.has(sessionId)) return this.sessionStops.get(sessionId);
    const streams = this.registry.list(sessionId);
    const audio = this.audio.get(sessionId);
    const stopped = Promise.all([
      ...streams.map((stream) => this.stopStream(sessionId, stream.id)),
      ...(audio
        ? [
            this.media.stop(audio.id).then(() => {
              if (this.audio.get(sessionId) === audio) this.audio.delete(sessionId);
            }),
          ]
        : []),
    ]).finally(() => this.sessionStops.delete(sessionId));
    this.sessionStops.set(sessionId, stopped);
    return stopped;
  }
  async revalidate() {
    await Promise.all(
      this.registry
        .list()
        .filter((stream) => !this.valid(stream))
        .map((stream) => this.stopStream(stream.sessionId, stream.id)),
    );
  }
  async stopAll() {
    await Promise.all(
      [...new Set([...this.registry.list().map((s) => s.sessionId), ...this.audio.keys()])].map(
        (id) => this.stopSession(id),
      ),
    );
  }
  async shutdown() {
    this.stopping = true;
    await this.stopAll();
    await this.media.shutdown();
  }
}
