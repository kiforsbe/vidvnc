import { StreamRegistry, audioFormat } from './stream-registry.mjs';
import { ControlLease } from './control-lease.mjs';
import { resolveStreamPolicy } from './stream-policy.mjs';
import { hostStatus } from './host-status.mjs';
import { Diagnostics } from './diagnostics.mjs';
import { Recovery } from './recovery.mjs';
import { peerSample } from './media-sample.mjs';

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
    // Diagnostics and recovery belong to each client subscription, not to the shared worker.
    this.streamDiagnostics = new Map();
    this.recoveries = new Map();
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
    // The lease addresses subscriptions; the worker it talks to is the subscription's source.
    this.control = new ControlLease({
      media: {
        setPermission: (streamId, allowed) => {
          const source = registry.sourceOf(streamId);
          if (!source) return Promise.reject(new Error('Inactive control worker'));
          return media.setPermission(source.id, streamId, allowed);
        },
        removePeer: (streamId) => this.#endSubscription(streamId),
      },
      isActive: (sessionId, streamId) => {
        const source = registry.sourceOf(streamId);
        return (
          sessions.list().some((s) => s.sessionId === sessionId) &&
          registry.get(sessionId, streamId)?.state === 'live' &&
          source?.state === 'ready' &&
          media.workers.has(source.id)
        );
      },
    });
    const onExit = media.onExit;
    media.onExit = (id, exit) => {
      for (const streamId of registry.source(id)?.subscriptions ?? []) this.#forget(streamId);
      registry.releaseSource(id);
      onExit?.(id, exit);
    };
    const onMetrics = media.onMetrics;
    media.onMetrics = (id, message) => {
      for (const streamId of registry.source(id)?.subscriptions ?? [])
        this.streamDiagnostics.get(streamId)?.record('server', peerSample(message, streamId));
      onMetrics?.(id, message);
    };
    const onPeerFailed = media.onPeerFailed;
    media.onPeerFailed = (id, peerId, reason) => {
      this.#endSubscription(peerId).catch((error) =>
        console.error('Stream cleanup failed:', error.message),
      );
      onPeerFailed?.(id, peerId, reason);
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
  // Read-only view of session audio subscriptions.
  get audio() {
    return new Map(
      this.registry
        .list(undefined, 'audio')
        .map((stream) => [stream.sessionId, { id: stream.id, state: stream.state }]),
    );
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
  #audioOf(sessionId) {
    return this.registry.list(sessionId, 'audio')[0] ?? null;
  }
  status() {
    const owner = this.control.owner;
    const sessions = this.sessions.list().map((session) => {
      const row = hostStatus([session], null).sessions[0];
      row.control = owner?.sessionId === session.sessionId ? 'Granted' : 'View only';
      row.controlStreamId = owner?.sessionId === session.sessionId ? owner.streamId : null;
      row.selectedStreamId = this.selected.get(session.sessionId) ?? null;
      const audio = this.#audioOf(session.sessionId);
      row.audio = audio?.state === 'live';
      row.audioViewers = audio ? (this.registry.source(audio.sourceId)?.subscriptions.length ?? 0) : 0;
      const health = [];
      row.streams = this.registry.list(session.sessionId).map((stream) => {
        const metrics = this.streamDiagnostics.get(stream.id)?.snapshot() ?? {};
        const derived = hostStatus([{ ...session, ...stream.plan }], session.sessionId, metrics)
          .sessions[0];
        health.push(derived.health);
        return {
          ...derived.streams[0],
          id: stream.id,
          state: stream.state,
          viewers: this.registry.source(stream.sourceId)?.subscriptions.length ?? 1,
        };
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
    const metrics = this.streamDiagnostics.get(streamId)?.snapshot();
    if (!stream || !metrics) return null;
    const audio = this.#audioOf(stream.sessionId);
    return {
      ...metrics,
      sessionAudio: this.streamDiagnostics.get(audio?.id)?.snapshot() ?? null,
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
  // Admits a subscription, starting its source when no matching one exists, and negotiates the
  // client's peer. A joiner's add-peer follows the creator's start in the worker pipe.
  async #subscribe(sessionId, plan, sdp, { start, configure, valid }) {
    let admitted;
    try {
      admitted = this.registry.subscribe(sessionId, plan);
    } catch (error) {
      throw Object.assign(error, { status: 409 });
    }
    const { stream, source, created } = admitted;
    const diagnostics = new Diagnostics();
    configure(diagnostics);
    this.streamDiagnostics.set(stream.id, diagnostics);
    this.recoveries.set(stream.id, new Recovery());
    try {
      const started = created
        ? this.media.start(source.id, start).then(() => this.registry.markReady(source.id))
        : Promise.resolve();
      const [ready, peer] = await Promise.allSettled([
        started,
        this.media.addPeer(source.id, stream.id, sdp),
      ]);
      if (ready.status === 'rejected') throw ready.reason;
      if (peer.status === 'rejected') throw peer.reason;
      if (
        !this.sessions.get(sessionId) ||
        this.stopping ||
        !valid() ||
        !this.registry.transition(sessionId, stream.id, 'live')
      )
        throw new Error('Stream ended during negotiation');
      return { stream, answer: peer.value };
    } catch (error) {
      await this.#endSubscription(stream.id);
      throw error;
    }
  }
  // Removes one client's peer; the source stops with its last subscription. Never touches
  // control, so the lease can use it as its fail-closed path.
  async #endSubscription(streamId) {
    const stream = this.registry.subscription(streamId);
    if (!stream) return;
    this.registry.transition(stream.sessionId, streamId, 'closing');
    if (this.media.workers.has(stream.sourceId))
      await this.media.removePeer(stream.sourceId, streamId);
    const { source, last } = this.registry.unsubscribe(streamId);
    this.#forget(streamId);
    if (!last) return;
    if (this.media.workers.has(source.id)) await this.media.stop(source.id);
    else this.registry.releaseSource(source.id);
  }
  #forget(streamId) {
    this.streamDiagnostics.delete(streamId);
    this.recoveries.delete(streamId);
    this.telemetryTimes.delete(streamId);
    for (const [sessionId, selected] of this.selected)
      if (selected === streamId) this.selected.delete(sessionId);
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
    let display, effective;
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
    const plan = {
      profile: effective.profile,
      display,
      revision: effective.revision,
      audio: { mode: 'off', enabled: false },
    };
    const { stream, answer } = await this.#subscribe(sessionId, plan, request.sdp, {
      start: { video: true, profile: effective.profile, display },
      configure: (diagnostics) => diagnostics.startStream(plan.profile, plan.audio, display),
      valid: () => this.valid({ plan }),
    });
    return {
      streamId: stream.id,
      type: 'answer',
      sdp: answer,
      profile: stream.plan.profile,
      display,
    };
  }
  record(sessionId, streamId, sample) {
    const stream = this.registry.get(sessionId, streamId);
    const diagnostics = this.streamDiagnostics.get(streamId);
    const source = this.registry.sourceOf(streamId);
    if (stream?.state !== 'live' || !diagnostics || !source) return false;
    const now = this.clock();
    if (now - (this.telemetryTimes.get(streamId) ?? -Infinity) < 800) return false;
    this.telemetryTimes.set(streamId, now);
    diagnostics.record('client', sample);
    // Each viewer trips its own recovery; the source-wide limit coalesces the keyframes.
    if (this.recoveries.get(streamId)?.observe(sample, now)) this.media.keyframe(source.id);
    return true;
  }
  recordAudio(sessionId, streamId, sample) {
    const audio = this.#audioOf(sessionId);
    const diagnostics = this.streamDiagnostics.get(streamId);
    if (audio?.id !== streamId || audio.state !== 'live' || !diagnostics) return false;
    const now = this.clock();
    if (now - (this.telemetryTimes.get(streamId) ?? -Infinity) < 800) return false;
    this.telemetryTimes.set(streamId, now);
    return diagnostics.record('client', sample);
  }
  async offerAudio(sessionId, sdp) {
    const session = this.sessions.get(sessionId);
    if (!session || this.stopping || this.sessionStops.has(sessionId))
      throw new Error('Inactive session');
    if (this.#audioOf(sessionId))
      throw Object.assign(new Error('Session audio already active'), { status: 409 });
    if (!session.audio?.enabled || !this.policy.snapshot().allowAudio || this.policy.busy)
      throw Object.assign(new Error('Desktop audio is not allowed'), { status: 403 });
    if (typeof sdp !== 'string' || !sdp.startsWith('v=0') || sdp.length > 65536)
      throw new Error('Invalid SDP');
    const format = audioFormat(session.profile);
    const { stream, answer } = await this.#subscribe(sessionId, { kind: 'audio', format }, sdp, {
      start: { video: false, audioFormat: format },
      configure: (diagnostics) => diagnostics.startStream(session.profile, { mode: 'on' }, null),
      valid: () => this.policy.snapshot().allowAudio,
    });
    return { streamId: stream.id, type: 'answer', sdp: answer };
  }
  async stopStream(sessionId, streamId) {
    if (!this.registry.get(sessionId, streamId)) throw new Error('Unknown stream');
    this.registry.transition(sessionId, streamId, 'closing');
    if (this.control.owner?.streamId === streamId) await this.control.revoke(sessionId);
    await this.#endSubscription(streamId);
  }
  stopSession(sessionId) {
    if (this.sessionStops.has(sessionId)) return this.sessionStops.get(sessionId);
    const streams = this.registry.list(sessionId);
    const audio = this.#audioOf(sessionId);
    const stopped = Promise.all([
      ...streams.map((stream) => this.stopStream(sessionId, stream.id)),
      ...(audio ? [this.#endSubscription(audio.id)] : []),
    ]).finally(() => this.sessionStops.delete(sessionId));
    this.sessionStops.set(sessionId, stopped);
    return stopped;
  }
  // A display or policy change ends every subscription of the affected sources; their
  // subscriptions are released when the worker exits.
  async revalidate() {
    await Promise.all(
      this.registry
        .sources()
        .filter((source) => source.kind === 'video' && source.state !== 'closing')
        .filter((source) => !this.valid(source))
        .map(async (source) => {
          const owner = this.control.owner;
          if (owner && source.subscriptions.includes(owner.streamId))
            await this.control.revoke(owner.sessionId);
          this.registry.closeSource(source.id);
          if (this.media.workers.has(source.id)) await this.media.stop(source.id);
          else {
            for (const streamId of source.subscriptions) this.#forget(streamId);
            this.registry.releaseSource(source.id);
          }
        }),
    );
  }
  async stopAll() {
    const owners = [
      ...this.registry.list(),
      ...this.registry.list(undefined, 'audio'),
    ].map((stream) => stream.sessionId);
    await Promise.all([...new Set(owners)].map((id) => this.stopSession(id)));
  }
  async shutdown() {
    this.stopping = true;
    await this.stopAll();
    await this.media.shutdown();
  }
}
