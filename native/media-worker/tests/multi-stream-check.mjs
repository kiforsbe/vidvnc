// Explicit hardware acceptance: loopback viewers only; captures desktop/system audio,
// but never sends keyboard, pointer or touch events. Leaves other running hosts alone.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { NativeMedia, probe } from '../../../apps/server/src/native-media.mjs';
import { SessionStore } from '../../../apps/server/src/session-store.mjs';
import { StreamRuntime } from '../../../apps/server/src/stream-runtime.mjs';
import { createHttpApp } from '../../../apps/server/src/http-app.mjs';
import { DisplayInventory } from '../../../apps/server/src/displays.mjs';
import { defaultStreamPolicy } from '../../../apps/server/src/stream-policy.mjs';
const { chromium } = createRequire(import.meta.url)(process.argv[2]);
const info = probe();
const displays = info.displays.filter((d) => d.persistent).slice(0, 2);
assert.ok(displays.length, 'This acceptance check requires a connected display');
const policy = defaultStreamPolicy();
policy.defaultProfileId = 'balanced';
policy.displaySharing = Object.fromEntries(displays.map((d) => [d.id, true]));
const sessions = new SessionStore({ maxSessions: 2 });
const media = new NativeMedia({ maxWorkers: 6, hostControl: true });
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
const browser = await chromium.launch({ headless: true });
const errors = [];
const children = [];
const workerErrors = [];
let phase = 'startup';
const renew = setInterval(() => runtime.control.renew(), 2000);
try {
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    pages.push(page);
    await page.addInitScript(() => {
      const create = RTCPeerConnection.prototype.createDataChannel;
      RTCPeerConnection.prototype.createDataChannel = function (...args) {
        const channel = create.apply(this, args);
        (window.testInputChannels ??= []).push(channel);
        channel.addEventListener('message', (event) => {
          try {
            const value = JSON.parse(event.data);
            if (typeof value.control === 'boolean') window.lastNativePermission = value.control;
          } catch {}
        });
        return channel;
      };
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('#password').fill(sessions.password);
    await page.locator('#connect').click();
    await page
      .waitForFunction(() => document.getElementById('video').videoWidth > 0, null, {
        timeout: 20000,
      })
      .catch(async (error) => {
        console.error('Viewer startup:', await page.locator('#status').textContent());
        console.error(
          'Stream metrics:',
          runtime.registry.list().map((stream) => {
            const metrics = runtime.streamDiagnostics.get(stream.id)?.snapshot();
            return {
              state: stream.state,
              capture: metrics?.server?.captureFrames,
              encoded: metrics?.server?.encodedFrames,
              decoded: metrics?.client?.framesDecoded,
            };
          }),
        );
        throw error;
      });
  }
  if (displays.length > 1) {
    await pages[0].locator('.display-chip').nth(1).click();
    await pages[0].waitForFunction(
      () =>
        document.querySelectorAll('.display-chip[aria-current="true"] .display-number')[0]
          ?.textContent === '2',
    );
  }
  await pages[0].waitForTimeout(4000);
  const videoCount = displays.length > 1 ? 3 : 2;
  assert.equal(runtime.registry.list().length, videoCount);
  assert.equal(runtime.audio.size, 2);
  // Display 1 is shared by both viewers; audio is one shared mix.
  const sourceCount = displays.length > 1 ? 3 : 2;
  assert.equal(runtime.registry.sources().length, sourceCount);
  assert.equal(media.workers.size, sourceCount);
  children.push(...[...media.workers.values()].map((worker) => worker.child));
  for (const child of children)
    child.stderr.on('data', (data) => workerErrors.push({ phase, message: String(data) }));
  for (const row of runtime.registry.list()) {
    const metrics = runtime.streamDiagnostics.get(row.id).snapshot();
    assert.ok(metrics.server.captureFrames > 0, 'native capture advances');
    assert.ok(metrics.client.framesDecoded > 0, 'browser decodes the native stream');
  }
  const [a, b] = sessions.list();
  assert.equal(await pages[0].locator('#control').isEnabled(), false);
  await pages[0].evaluate(() => {
    window.lastNativePermission = null;
    window.testInputChannels.at(-1).send(JSON.stringify({ type: 'control', enabled: true }));
  });
  await pages[0].waitForFunction(() => window.lastNativePermission === false);
  await runtime.command({ action: 'grant', sessionId: a.sessionId });
  await pages[0].waitForFunction(() => !document.getElementById('control').disabled);
  // Permission toggle only; do not inject any OS input.
  await pages[0].locator('#stage').hover({ position: { x: 20, y: 20 } });
  await pages[0].locator('#control').click();
  await pages[0].waitForFunction(() => window.lastNativePermission === true);
  await pages[0].waitForFunction(
    () => document.getElementById('control').getAttribute('aria-pressed') === 'true',
  );
  phase = 'control transfer';
  await runtime.command({ action: 'grant', sessionId: b.sessionId });
  await pages[0].waitForFunction(() => document.getElementById('control').disabled);
  await pages[1].waitForFunction(() => !document.getElementById('control').disabled);
  assert.equal(runtime.control.owner.sessionId, b.sessionId);
  await runtime.command({ action: 'revoke', sessionId: b.sessionId });
  await pages[1].waitForFunction(() => document.getElementById('control').disabled);
  await pages[1].evaluate(() => {
    window.lastNativePermission = null;
    window.testInputChannels.at(-1).send(JSON.stringify({ type: 'control', enabled: true }));
  });
  await pages[1].waitForFunction(() => window.lastNativePermission === false);
  phase = 'client disconnect';
  await pages[0].locator('#disconnect').click();
  await pages[1].waitForTimeout(500);
  assert.equal(media.workers.size, 2, 'the remaining viewer keeps its video and audio sources');
  assert.equal(await pages[1].locator('#video').evaluate((v) => v.paused), false);
  phase = 'server shutdown';
  await runtime.shutdown();
  assert.equal(media.workers.size, 0);
  assert.ok(
    children.every((child) => child.exitCode !== null || child.signalCode !== null),
    'all owned OS subprocesses exited',
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(workerErrors, [], 'native teardown must not report resource errors');
  console.log(
    `PASS: native ${videoCount} video/two audio subscriptions on ${sourceCount} shared sources, host permission transfer/revoke between peers, isolated disconnect and zero owned workers`,
  );
  if (displays.length < 2)
    console.log('NOT TESTED: simultaneous capture of two physical displays (only one connected).');
} finally {
  clearInterval(renew);
  await runtime.shutdown();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await browser.close();
}
