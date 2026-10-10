// The real owner-protocol code (owner-commands.mjs) wired to real settings, sessions,
// policy, approved clients, codes, diagnostics and stream runtime, with a recorded media
// worker (../media-process.mjs) and no capture, sockets or certificate tooling. Used by
// owner-protocol.test.mjs to hold the server's replies and lines to the fixtures here.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccessSettings } from '../../../src/access-settings.mjs';
import { AdmissionBudget } from '../../../src/admission-budget.mjs';
import { ApprovedClientStore } from '../../../src/approved-clients.mjs';
import { createCodeIssuer } from '../../../src/code-issuance.mjs';
import { DiagnosticsCapabilities } from '../../../src/diagnostics-capabilities.mjs';
import { DisplayInventory } from '../../../src/displays.mjs';
import { MediaRelay } from '../../../src/media-relay.mjs';
import { NativeMedia } from '../../../src/native-media.mjs';
import {
  createOwnerCommandHandler,
  displaysLine,
  readyMessage,
  statusLines,
} from '../../../src/owner-commands.mjs';
import { createOwnerSecurityCommands } from '../../../src/owner-security-commands.mjs';
import { PolicyController } from '../../../src/policy-controller.mjs';
import { SessionStore } from '../../../src/session-store.mjs';
import { StreamPolicyStore } from '../../../src/stream-policy-store.mjs';
import { StreamRuntime } from '../../../src/stream-runtime.mjs';
import { tlsDesktopStatus } from '../../../src/tls/desktop-status.mjs';

export const DISPLAYS = [0, 1].map((index) => ({
  id: (index ? 'b' : 'a').repeat(64),
  name: `Display ${index + 1}`,
  primary: index === 0,
  persistent: true,
  x: index * 1920,
  y: 0,
  width: 1920,
  height: 1080,
  rotation: 0,
}));

export const BACKENDS = [
  {
    id: 'nvenc',
    label: 'NVIDIA NVENC',
    codecs: ['h264'],
    minimums: { h264: { width: 64, height: 64 } },
  },
];

const VIDEO_SDP = [
  'v=0',
  'o=- 0 0 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=rtpmap:96 H264/90000',
].join('\r\n');

// `tlsMode` picks the TLS settings the tls-regenerate refusals depend on.
export async function ownerServer({ tlsMode = 'off' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'vidvnc-owner-protocol-'));
  const access = await AccessSettings.open(join(directory, 'access.json'));
  const admission = new AdmissionBudget();
  const store = new SessionStore({ maxSessions: () => access.snapshot().maxSessions });
  let runtime;
  const policy = new PolicyController(
    await StreamPolicyStore.open(join(directory, 'policy.json')),
    store,
    { shutdown: async () => runtime?.stopAll() },
  );
  const inventory = new DisplayInventory(DISPLAYS);
  const initial = policy.snapshot();
  await policy.replace(
    { ...initial, displaySharing: Object.fromEntries(DISPLAYS.map(({ id }) => [id, true])) },
    initial.revision,
  );
  const approvedClients = await ApprovedClientStore.open(join(directory, 'clients.json'), {
    keys: store.keys,
    admission,
  });
  const codeIssuer = createCodeIssuer({ access, sessionStore: store, admission });
  const diagnosticsCapabilities = new DiagnosticsCapabilities();
  const media = new NativeMedia({
    maxWorkers: 4,
    hostControl: true,
    launch: () =>
      spawn(process.execPath, [fileURLToPath(new URL('../media-process.mjs', import.meta.url))], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
  });
  runtime = new StreamRuntime({
    sessions: store,
    media,
    inventory,
    policy,
    access,
    approvedClients,
    videoCodecs: ['h264'],
    videoBackends: BACKENDS,
  });
  const ownerSecurity = createOwnerSecurityCommands({ store, approvedClients, runtime });
  const tlsSettings = { mode: tlsMode, port: 4383, invalid: false };
  // A listener that is serving in `auto` and `provided` modes; no certificate is issued.
  const serving = tlsMode !== 'off';
  const tlsListener = {
    report: () => ({ strategy: serving ? (tlsMode === 'provided' ? 'provided' : 'mkcert') : null }),
    displays: () => displaysLine(inventory),
    status: () => ({ active: serving, port: serving ? 4383 : null }),
    attempt: async () => {},
  };
  const tlsField = () =>
    tlsDesktopStatus({
      settings: tlsSettings,
      status: tlsListener.status(),
      report: tlsListener.report(),
      localHttpUrls: ['http://192.168.1.10:4382/'],
      secureUrls: serving ? ['https://192.168.1.10:4383/'] : [],
    });
  const lines = [];
  let stopped = false;
  const handle = createOwnerCommandHandler({
    write: (line) => lines.push(JSON.parse(line)),
    stop: () => {
      stopped = true;
    },
    stopping: () => stopped,
    diagnosticsCapabilities,
    diagnosticsUrl: () => 'http://127.0.0.1:45999/diagnostics',
    codeIssuer,
    approvedClients,
    store,
    ownerSecurity,
    access,
    runtime,
    policy,
    tlsSettings,
    tlsListener,
    tlsField,
  });

  // Sends one command and resolves with every line written until `count` have arrived.
  async function send(command, count = 1) {
    const from = lines.length;
    handle(typeof command === 'string' ? command : JSON.stringify(command));
    const deadline = Date.now() + 2000;
    while (lines.length - from < count) {
      if (Date.now() > deadline) throw new Error(`No reply to ${JSON.stringify(command)}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return lines.slice(from);
  }

  // One connected viewer with a live stream, one pending and one approved device, so every
  // array in the status and clients lines has a row to compare.
  async function populate() {
    const sessionId = store.connect(store.password, '192.168.1.20').sessionId;
    store.setProfile(sessionId, { name: 'mobile', width: 1280, height: 720, fps: 15 });
    const { streamId } = await runtime.offerVideo(sessionId, {
      sdp: VIDEO_SDP,
      displayId: DISPLAYS[0].id,
      profile: 'mobile',
    });
    const register = async (deviceName) => {
      store.keys.createSetup({ ttlMs: 60_000 });
      return approvedClients.submit({
        registrationTicket: approvedClients.issueRegistrationTicket().registrationTicket,
        deviceName,
        username: 'owner',
        password: 'correct horse battery staple',
        installationId: `installation-${deviceName}`,
        client: 'Safari on iOS',
        network: 'Local network',
      });
    };
    await approvedClients.approve((await register('Phone')).requestId);
    const approvedId = approvedClients.status().approved[0].id;
    const pending = await register('Tablet');
    // The real relay class, never started: its status() is what the host reads. Attached
    // after the stream starts, because a relay that is not listening refuses offers.
    runtime.relay = new MediaRelay({ port: () => 4384 });
    return { sessionId, streamId, pendingId: pending.requestId, approvedId };
  }

  return {
    send,
    lines,
    populate,
    stopped: () => stopped,
    approvedClients,
    displays: () => displaysLine(inventory),
    status: () => statusLines({ runtime, tlsField, codeIssuer, approvedClients, store }),
    ready: (sharingNotice) =>
      readyMessage({
        sharingNotice,
        tlsField,
        store,
        info: { width: 1920, height: 1080, displays: DISPLAYS, backends: BACKENDS },
        policy,
        access,
        approvedClients,
        hostCodecs: ['h264'],
        versions: { server: '0.10.0', node: '24.0.0', gstreamer: '1.28.6' },
      }),
    async close() {
      await runtime.shutdown();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
