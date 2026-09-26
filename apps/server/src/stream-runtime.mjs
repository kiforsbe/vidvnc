import { StreamRegistry, audioFormat } from './stream-registry.mjs';
import { ControlLease } from './control-lease.mjs';
import { resolveStreamPolicy } from './stream-policy.mjs';
import { hostStatus } from './host-status.mjs';
import { Diagnostics } from './diagnostics.mjs';
import { Recovery } from './recovery.mjs';
import { peerSample } from './media-sample.mjs';
import { selectVideoCodec } from './video-codecs.mjs';
import { selectEncoderBackend } from './encoder-backends.mjs';
import { effectivePermission } from './approved-client-permission.mjs';
import { sourceGroup } from './peer-network.mjs';
import {
  announceRelay,
  iceCredentials,
  stripOfferCandidates,
  validateRelayAnswer,
} from './sdp-candidates.mjs';

// How long a client has, after its answer, to send an authenticated check through the relay.
const RELAY_EXPIRES_MS = 15_000;

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
    videoCodecs = ['h264'],
    videoBackends = [],
    // The media relay (media-relay.mjs) and the addresses a client is told to send media to
    // (relay-addresses.mjs). Without a relay, offers and answers pass through unchanged, which
    // only tests rely on: the server always runs one.
    relay = null,
    relayAddresses = null,
  }) {
    this.relay = relay;
    this.relayAddresses = relayAddresses;
    Object.assign(this, {
      sessions,
      media,
      inventory,
      policy,
      access,
      approvedClients,
      registry,
      clock,
      videoCodecs,
      videoBackends,
    });
    this.stopping = false;
    this.sessionStops = new Map();
    this.telemetryTimes = new Map();
    // Diagnostics and recovery belong to each client subscription, not to the shared worker.
    this.streamDiagnostics = new Map();
    this.recoveries = new Map();
    this.selected = new Map();
    // Sessions that may take keyboard and mouse control on their own request, without the
    // host (the Allow when available default or the device's own setting, captured when the
    // session was admitted). A host revoke for the session removes it.
    this.automaticControl = new Set();
    // Per stream registered with the relay: the HTTPS address and the authenticated media
    // path, for Sessions and diagnostics.
    this.relayPaths = new Map();
    const onConnect = sessions.onConnect;
    sessions.onConnect = (id) => {
      onConnect?.(id);
      const session = sessions.get(id);
      const approvedClientId = session?.approvedClientId;
      const auth = approvedClientId ? approvedClients?.authorization(approvedClientId) : null;
      const current = !approvedClientId || (auth && auth.generation === session.approvedGeneration);
      const control = approvedClientId
        ? effectivePermission(current ? auth : null, this.#defaultControl())
        : this.#defaultControl();
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
      isActive: (sessionId, streamId, options) => this.currentControl(sessionId, streamId, options),
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
  currentControl(sessionId, streamId, { explicitOwner = false } = {}) {
    const session = this.sessions.list().find((row) => row.sessionId === sessionId);
    const source = this.registry.sourceOf(streamId);
    if (
      !session ||
      this.registry.get(sessionId, streamId)?.state !== 'live' ||
      source?.state !== 'ready' ||
      !this.media.workers.has(source.id)
    )
      return false;
    const auth = session.approvedClientId
      ? this.approvedClients?.authorization(session.approvedClientId)
      : null;
    const current =
      !session.approvedClientId || (auth && auth.generation === session.approvedGeneration);
    const permission = session.approvedClientId
      ? effectivePermission(current ? auth : null, this.#defaultControl())
      : this.#defaultControl();
    return explicitOwner ? permission !== 'view-only' : permission === 'available';
  }
  // The Access page default for this session, the same from the LAN and the internet (where
  // only approved devices can sign in at all). An approved device's own setting overrides it.
  #defaultControl() {
    return this.access?.snapshot().defaultControl ?? 'view-only';
  }
  async revokeApprovedClient(clientId) {
    const affected = this.sessions.list().filter((row) => row.approvedClientId === clientId);
    for (const row of affected) this.automaticControl.delete(row.sessionId);
    const results = await Promise.all(affected.map((row) => this.control.revoke(row.sessionId)));
    return {
      nativeAck: results.every((result) => result.nativeAck),
      peerTerminated: results.some((result) => result.peerTerminated),
    };
  }
  async selectStream(sessionId, streamId) {
    if (!this.sessions.get(sessionId) || this.registry.get(sessionId, streamId)?.state !== 'live')
      throw Object.assign(new Error('Unknown stream'), { status: 404 });
    if (this.control.owner?.sessionId === sessionId && this.control.owner.streamId !== streamId) {
      const explicitOwner = this.control.explicitOwner;
      if (this.currentControl(sessionId, streamId, { explicitOwner }))
        await this.control.grant(sessionId, streamId, { explicitOwner });
      else await this.control.revoke(sessionId);
    }
    if (this.registry.get(sessionId, streamId)?.state !== 'live') throw new Error('Stream ended');
    this.selected.set(sessionId, streamId);
    return this.controlState(sessionId);
  }
  // What the viewer needs to draw its Control button: the stream it holds control on, and
  // whether it may take control itself right now (nobody else holds it).
  controlState(sessionId) {
    const owner = this.control.owner;
    const selected = this.selected.get(sessionId);
    return {
      controlStreamId: owner?.sessionId === sessionId ? owner.streamId : null,
      controlRequestable:
        !owner &&
        selected !== undefined &&
        this.automaticControl.has(sessionId) &&
        this.currentControl(sessionId, selected),
    };
  }
  // The viewer's user asked for keyboard and mouse. Granted without the host when the session
  // may take control and nobody else holds it; never taken from another session.
  async requestControl(sessionId, streamId) {
    if (!this.sessions.get(sessionId) || this.selected.get(sessionId) !== streamId)
      throw Object.assign(new Error('Unknown stream'), { status: 404 });
    const owner = this.control.owner;
    if (owner?.sessionId === sessionId && owner.streamId === streamId)
      return this.controlState(sessionId);
    if (!this.automaticControl.has(sessionId) || !this.currentControl(sessionId, streamId))
      throw Object.assign(new Error('The host must give this device keyboard and mouse control.'), {
        status: 403,
      });
    await this.control.grant(sessionId, streamId, { onlyIfAvailable: true });
    if (this.control.owner?.sessionId !== sessionId)
      throw Object.assign(new Error('Another device has keyboard and mouse control.'), {
        status: 409,
      });
    return this.controlState(sessionId);
  }
  // The viewer's user released keyboard and mouse. Control the session took itself is handed
  // back so another device can ask; control the host granted stays until the host revokes it.
  async releaseControl(sessionId) {
    if (this.control.owner?.sessionId === sessionId && !this.control.explicitOwner)
      await this.control.revoke(sessionId);
    return this.controlState(sessionId);
  }
  // Called only by the local owner command pipe, never by an HTTP admin route.
  async command({ action, sessionId, streamId }) {
    if (!this.sessions.list().some((session) => session.sessionId === sessionId))
      throw new Error('Device disconnected');
    if (action === 'revoke') this.automaticControl.delete(sessionId);
    if (
      action === 'grant' &&
      !this.currentControl(sessionId, this.selected.get(sessionId), { explicitOwner: true })
    )
      throw new Error('Control is view only or unavailable');
    if (action === 'grant')
      return this.control.grant(sessionId, this.selected.get(sessionId), { explicitOwner: true });
    if (action === 'revoke') return this.control.revoke(sessionId);
    if (action === 'stop-stream') return this.stopStream(sessionId, streamId);
    throw new Error('Unknown session action');
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
      row.audioViewers = audio
        ? (this.registry.source(audio.sourceId)?.subscriptions.length ?? 0)
        : 0;
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
          codec: stream.plan.codec ?? 'h264',
          // What the worker actually chose, not what policy asked for: the two differ when a
          // named backend is absent and the worker substitutes one.
          encoder: this.media.encoder?.(stream.sourceId) ?? null,
          ...this.#mediaPath(stream.id, session.clientKey),
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
      relay: this.relay?.status() ?? null,
      // Host-facing only. Which GPU encodes is the host's business; no client ever sees this.
      encoders: {
        available: this.videoBackends.map(({ id, label, codecs }) => ({ id, label, codecs })),
        setting: this.policy.snapshot().encoderBackend ?? 'auto',
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
  async #subscribe(sessionId, plan, sdp, { start, configure, valid }, network = {}) {
    // With the relay the worker never sees the client's candidates: it sends checks to
    // nobody and learns the client only from checks the relay has authenticated.
    let client = null;
    if (this.relay) {
      if (!this.relay.listening)
        throw Object.assign(
          new Error(
            `Media is unavailable: ${this.relay.reason ?? 'the media relay is not running'}`,
          ),
          { status: 503 },
        );
      try {
        client = iceCredentials(sdp);
      } catch {
        throw Object.assign(new Error('Invalid SDP'), { status: 400 });
      }
      sdp = stripOfferCandidates(sdp);
    }
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
      let answer = peer.value;
      if (this.relay)
        answer = await this.#throughRelay(source.id, stream.id, answer, client, network);
      // Known only once the worker is ready: which GPU won, and why.
      diagnostics.setEncoder(this.media.encoder?.(source.id) ?? null);
      if (
        !this.sessions.get(sessionId) ||
        this.stopping ||
        !valid() ||
        !this.registry.transition(sessionId, stream.id, 'live')
      )
        throw new Error('Stream ended during negotiation');
      return { stream, answer };
    } catch (error) {
      await this.#endSubscription(stream.id);
      // Ended while the relay was confirming: the subscription was already gone.
      if (this.relayPaths.delete(stream.id)) this.relay.revoke(stream.id);
      throw error;
    }
  }
  // Registers the stream with the relay and returns the answer the client gets: the worker's
  // loopback candidate replaced by the relay's port on addresses this client can reach. The
  // registration is confirmed before the answer leaves, so the first check is never dropped.
  async #throughRelay(
    sourceId,
    streamId,
    answer,
    client,
    { internet = false, clientHint = null, localAddress } = {},
  ) {
    const worker = validateRelayAnswer(answer);
    // The answer comes from the source's sandboxed network process and is untrusted: its
    // loopback port must be one that process really owns, or the relay would forward an
    // authenticated client to some other program's socket.
    if (!(await this.media.checkPort(sourceId, streamId, worker.port)))
      throw new Error('The network process answered with a port it does not own.');
    const addresses = await this.relayAddresses({ internet, localAddress });
    await this.relay.allow({
      streamId,
      ufrag: worker.ufrag,
      pwd: worker.pwd,
      clientUfrag: client.ufrag,
      clientPwd: client.pwd,
      workerPort: worker.port,
      clientHint,
      expiresMs: RELAY_EXPIRES_MS,
    });
    this.relayPaths.set(streamId, { https: clientHint, media: null });
    return announceRelay(answer, addresses, this.relay.port);
  }
  // Where a stream's media comes from, as the relay authenticated it, and whether that
  // differs from the address the device signed in from (allowed: iCloud Private Relay and
  // carrier-grade NAT do it).
  #mediaPath(streamId, httpsAddress) {
    const media = this.relayPaths.get(streamId)?.media ?? null;
    if (!media) return { mediaAddress: null, mediaDiffers: false };
    const host = media.startsWith('[') ? media.slice(1, media.indexOf(']')) : media.split(':')[0];
    return {
      mediaAddress: media,
      mediaDiffers: sourceGroup(host) !== sourceGroup(httpsAddress),
    };
  }
  // Relay events for a stream: a media path authenticated or ended, or nobody authenticated
  // in time (the stream then fails).
  relayEvent(event) {
    const path = this.relayPaths.get(event.streamId);
    if (event.type === 'pinned' && path) path.media = event.tuple;
    if (event.type === 'unpinned' && path?.media === event.tuple) path.media = null;
    if (event.type === 'expired')
      this.#endSubscription(event.streamId).catch((error) =>
        console.error('Stream cleanup failed:', error.message),
      );
  }
  // The relay stopped: no stream can carry media any more.
  relayStopped() {
    return this.stopAll().catch((error) => console.error('Stream cleanup failed:', error.message));
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
    if (this.relayPaths.delete(streamId)) this.relay?.revoke(streamId);
    this.streamDiagnostics.delete(streamId);
    this.recoveries.delete(streamId);
    this.telemetryTimes.delete(streamId);
    for (const [sessionId, selected] of this.selected)
      if (selected === streamId) this.selected.delete(sessionId);
  }
  async offerVideo(sessionId, request, network = {}) {
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
    const encoderBackend = selectEncoderBackend(this.videoBackends, effective.encoderBackend);
    const codec = selectVideoCodec(
      request.sdp,
      policy.videoCodecs,
      this.videoBackends,
      effective.profile,
      encoderBackend,
    );
    const plan = {
      profile: effective.profile,
      display,
      revision: effective.revision,
      audio: { mode: 'off', enabled: false },
      codec,
      encoderBackend,
    };
    const { stream, answer } = await this.#subscribe(
      sessionId,
      plan,
      request.sdp,
      {
        start: {
          video: true,
          profile: effective.profile,
          display,
          codec,
          encoderBackend,
        },
        configure: (diagnostics) =>
          diagnostics.startStream(plan.profile, plan.audio, display, codec),
        valid: () => this.valid({ plan }),
      },
      network,
    );
    return {
      streamId: stream.id,
      type: 'answer',
      sdp: answer,
      profile: stream.plan.profile,
      display,
      codec: stream.plan.codec,
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
  async offerAudio(sessionId, sdp, network = {}) {
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
    const { stream, answer } = await this.#subscribe(
      sessionId,
      { kind: 'audio', format },
      sdp,
      {
        start: { video: false, audioFormat: format },
        configure: (diagnostics) => diagnostics.startStream(session.profile, { mode: 'on' }, null),
        valid: () => this.policy.snapshot().allowAudio,
      },
      network,
    );
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
    const owners = [...this.registry.list(), ...this.registry.list(undefined, 'audio')].map(
      (stream) => stream.sessionId,
    );
    await Promise.all([...new Set(owners)].map((id) => this.stopSession(id)));
  }
  async shutdown() {
    this.stopping = true;
    try {
      await this.stopAll();
    } finally {
      await this.media.shutdown();
    }
  }
}
