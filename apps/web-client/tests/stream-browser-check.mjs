// Real two-viewer WebRTC regression. Synthetic canvas + silent audio, no OS capture/input.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHttpApp } from '../../server/src/http-app.mjs';
import { SessionStore } from '../../server/src/session-store.mjs';
import { StreamRuntime } from '../../server/src/stream-runtime.mjs';
import { DisplayInventory } from '../../server/src/displays.mjs';
import { defaultStreamPolicy } from '../../server/src/stream-policy.mjs';
const { chromium } = createRequire(import.meta.url)(process.argv[2]);
const browser = await chromium.launch({ headless: true });
const sender = await browser.newPage();
const sessions = new SessionStore({ maxSessions: 2 });
const policy = defaultStreamPolicy();
const displays = [0, 1].map((i) => ({
  id: (i ? 'b' : 'a').repeat(64),
  name: i ? 'Second display' : 'Main display',
  persistent: true,
  primary: !i,
  x: i * 1280,
  y: 0,
  width: 1280,
  height: 720,
  rotation: 0,
}));
policy.displaySharing = Object.fromEntries(displays.map((d) => [d.id, true]));
const media = {
  workers: new Map(),
  async start(sourceId, { video = true } = {}) {
    this.workers.set(sourceId, { id: sourceId, video, peers: new Set() });
  },
  async addPeer(sourceId, peerId, sdp) {
    const worker = this.workers.get(sourceId);
    if (!worker) throw new Error('Native media worker stopped.');
    worker.peers.add(peerId);
    return sender.evaluate(
      async ({ id, sdp, video }) => {
        window.peers ??= new Map();
        const pc = new RTCPeerConnection({ iceServers: [] });
        let timer, context, stream;
        if (video) {
          const canvas = document.createElement('canvas');
          canvas.width = 1280;
          canvas.height = 720;
          const ctx = canvas.getContext('2d');
          let frame = 0;
          timer = setInterval(() => {
            ctx.fillStyle = frame++ % 2 ? '#246' : '#468';
            ctx.fillRect(0, 0, 1280, 720);
          }, 66);
          stream = canvas.captureStream(15);
        } else {
          context = new AudioContext();
          const source = context.createOscillator();
          const gain = context.createGain();
          gain.gain.value = 0;
          const destination = context.createMediaStreamDestination();
          source.connect(gain).connect(destination);
          source.start();
          stream = destination.stream;
        }
        stream.getTracks().forEach((track) => pc.addTrack(track, stream));
        pc.ondatachannel = (e) => {
          e.channel.onmessage = () => {};
        };
        window.peers.set(id, { pc, timer, context, stream });
        await pc.setRemoteDescription({ type: 'offer', sdp });
        await pc.setLocalDescription(await pc.createAnswer());
        if (pc.iceGatheringState !== 'complete')
          await new Promise((resolve) =>
            pc.addEventListener('icegatheringstatechange', () => {
              if (pc.iceGatheringState === 'complete') resolve();
            }),
          );
        return pc.localDescription.sdp;
      },
      { id: peerId, sdp, video: worker.video },
    );
  },
  async removePeer(sourceId, peerId) {
    const worker = this.workers.get(sourceId);
    if (!worker?.peers.delete(peerId)) return;
    await sender.evaluate(async (id) => {
      const peer = window.peers.get(id);
      if (!peer) return;
      peer.pc.close();
      clearInterval(peer.timer);
      peer.stream.getTracks().forEach((t) => t.stop());
      await peer.context?.close();
      window.peers.delete(id);
    }, peerId);
  },
  async stop(sourceId) {
    const worker = this.workers.get(sourceId);
    if (!worker) return;
    await Promise.all([...worker.peers].map((peerId) => this.removePeer(sourceId, peerId)));
    this.workers.delete(sourceId);
    this.onExit?.(sourceId, { expected: true });
  },
  async shutdown() {
    await Promise.all([...this.workers.keys()].map((id) => this.stop(id)));
  },
  async setPermission() {
    return false;
  },
  keyframe() {
    return false;
  },
};
const runtime = new StreamRuntime({
  sessions,
  media,
  inventory: new DisplayInventory(displays),
  policy: { snapshot: () => policy },
});
const server = createHttpApp({
  runtime,
  sessionStore: sessions,
  media,
  inventory: runtime.inventory,
  policy: runtime.policy,
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const errors = [];
try {
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    pages.push(page);
    await page.goto(url);
    await page.locator('#password').fill(sessions.password);
    await page.locator('#connect').click();
    await page
      .waitForFunction(() => document.getElementById('video').videoWidth > 0, null, {
        timeout: 15000,
      })
      .catch(async (error) => {
        console.error(await page.locator('#status').textContent(), errors);
        throw error;
      });
  }
  assert.equal(sessions.list().length, 2);
  assert.equal(runtime.selected.size, 2, 'each viewer reports its selected input target');
  assert.equal(runtime.registry.list().length, 2);
  assert.equal(runtime.audio.size, 2);
  await pages[0].getByRole('button', { name: '2 Second display' }).click();
  await pages[0].waitForFunction(
    () => document.getElementById('displayName').textContent === 'Second display',
  );
  assert.equal(runtime.registry.list().length, 3);
  const before = runtime.registry.list().map((s) => s.id);
  await pages[0].getByRole('button', { name: '1 Main display' }).click();
  await pages[0].waitForFunction(
    () => document.getElementById('displayName').textContent === 'Main display',
  );
  assert.deepEqual(
    runtime.registry.list().map((s) => s.id),
    before,
    'switching back reuses the subscription',
  );
  let releaseHeartbeat, markCaptured, markDelivered;
  const heldHeartbeat = new Promise((resolve) => {
    releaseHeartbeat = resolve;
  });
  const capturedHeartbeat = new Promise((resolve) => {
    markCaptured = resolve;
  });
  const deliveredHeartbeat = new Promise((resolve) => {
    markDelivered = resolve;
  });
  let held = false;
  await pages[0].route('**/api/heartbeat', async (route) => {
    if (held) return route.continue();
    held = true;
    const response = await route.fetch();
    markCaptured();
    await heldHeartbeat;
    await route.fulfill({ response });
    markDelivered();
  });
  await capturedHeartbeat;
  await pages[0].locator('#qualitySummary').click();
  await pages[0].locator('input[name="streamProfile"][value="balanced"]').check();
  await pages[0].waitForFunction(
    () => document.getElementById('qualitySummary').textContent === 'Quality: Balanced',
  );
  assert.equal(runtime.registry.list().length, 3);
  assert.equal(runtime.audio.size, 2);
  assert.equal(
    runtime.registry.list().filter((s) => before.includes(s.id)).length,
    2,
    'quality change replaces only selected video',
  );
  releaseHeartbeat();
  await deliveredHeartbeat;
  const retainedIds = runtime.registry.list().map((s) => s.id);
  await pages[0].getByRole('button', { name: '2 Second display' }).click();
  await pages[0].waitForFunction(
    () => document.getElementById('displayName').textContent === 'Second display',
  );
  await pages[0].getByRole('button', { name: '1 Main display' }).click();
  await pages[0].waitForFunction(
    () => document.getElementById('displayName').textContent === 'Main display',
  );
  assert.deepEqual(
    runtime.registry.list().map((s) => s.id),
    retainedIds,
    'switching retains each display profile and peer',
  );
  await pages[0].waitForTimeout(100);
  assert.ok(
    await pages[0].locator('#video').evaluate((v) => v.srcObject !== null),
    'a delayed heartbeat must not close a newly negotiated stream',
  );
  await pages[1].waitForTimeout(2200);
  assert.ok(
    [...runtime.audio.values()].every(
      (audio) => runtime.streamDiagnostics.get(audio.id).snapshot().client,
    ),
    'audio receiver metrics are reported once per device',
  );
  assert.ok(
    runtime.registry.list().every((s) => runtime.streamDiagnostics.get(s.id).snapshot().client),
    'all subscribed streams send metrics',
  );
  const diagnostics = await browser.newPage();
  await diagnostics.goto(url + '/diagnostics');
  await diagnostics.waitForFunction(
    () => document.querySelectorAll('#diagnosticStream option').length === 3,
  );
  const selectedId = runtime.registry.list().at(-1).id;
  await diagnostics.locator('#diagnosticStream').selectOption(selectedId);
  await diagnostics.waitForFunction(
    (id) => new URL(location.href).searchParams.get('stream') === id,
    selectedId,
  );
  await diagnostics.close();
  const ended = runtime.registry.list().find((stream) => stream.id === selectedId);
  await runtime.stopStream(ended.sessionId, ended.id);
  await pages[0].waitForFunction(() => document.getElementById('video').srcObject === null);
  await pages[0].getByRole('button', { name: '1 Main display' }).click();
  await pages[0].waitForFunction(() => document.getElementById('video').srcObject !== null, null, {
    timeout: 5000,
  });
  runtime.inventory.update([displays[0]]);
  await runtime.revalidate();
  await pages[0].waitForFunction(
    () => document.querySelectorAll('.display-chip').length === 1,
    null,
    { timeout: 6000 },
  );
  assert.equal(await pages[0].locator('#video').evaluate((v) => v.paused), false);
  runtime.inventory.update(displays);
  await pages[0].waitForFunction(
    () => document.querySelectorAll('.display-chip').length === 2,
    null,
    { timeout: 6000 },
  );
  await pages[0].locator('#disconnect').click();
  await pages[1].waitForTimeout(300);
  assert.equal(sessions.list().length, 1);
  assert.equal(runtime.registry.list().length, 1);
  assert.equal(runtime.audio.size, 1);
  assert.equal(await pages[1].locator('#video').evaluate((v) => v.paused), false);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: two viewers, three video streams, independent audio, quality replacement and disconnect',
  );
} finally {
  await runtime.shutdown();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await browser.close();
}
