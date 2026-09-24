// UI + real browser WebRTC fixture. No screen capture, native worker or OS input.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { createHttpApp } from '@vidvnc/server/http-app.mjs';
import { ApprovedClientStore } from '../../server/src/approved-clients.mjs';
import { SessionStore } from '../../server/src/session-store.mjs';
import { defaultStreamPolicy } from '../../server/src/stream-policy.mjs';
import { DisplayInventory } from '../../server/src/displays.mjs';
const { chromium } = createRequire(import.meta.url)(process.argv[2]);
const browser = await chromium.launch({ headless: true });
const sender = await browser.newPage();
const policy = defaultStreamPolicy();
policy.clientMode = 'options';
const displays = [
  {
    id: 'a'.repeat(64),
    name: 'Main display',
    primary: true,
    persistent: true,
    x: 0,
    y: 0,
    width: 2560,
    height: 1440,
    rotation: 0,
  },
  {
    id: 'b'.repeat(64),
    name: 'Second display',
    primary: false,
    persistent: true,
    x: -1920,
    y: 0,
    width: 1920,
    height: 1080,
    rotation: 0,
  },
];
policy.displaySharing = Object.fromEntries(displays.map((d) => [d.id, true]));
const offers = [];
const media = {
  async offer(id, sdp, profile, audio, display) {
    offers.push({ id, profile, audio, display });
    return sender.evaluate(
      async ({ id, sdp }) => {
        window.senders ??= new Map();
        window.inputMessages ??= [];
        const pc = new RTCPeerConnection({ iceServers: [] });
        const canvas = document.createElement('canvas');
        canvas.width = 1280;
        canvas.height = 720;
        const ctx = canvas.getContext('2d');
        let frame = 0;
        const draw = () => {
          ctx.fillStyle = '#123b70';
          ctx.fillRect(0, 0, 1280, 720);
          ctx.fillStyle = '#2378d0';
          ctx.fillRect(80, 80, 1120, 560);
          ctx.fillStyle = '#e5f2ff';
          ctx.font = '36px sans-serif';
          ctx.fillText('VidVNC · WebRTC test stream', 160, 310);
          ctx.font = '22px sans-serif';
          ctx.fillText('Browser-generated test pattern · no desktop capture', 160, 360);
          ctx.fillRect(160 + (frame++ % 500), 440, 100, 4);
        };
        draw();
        const timer = setInterval(draw, 66);
        const stream = canvas.captureStream(15);
        pc.addTrack(stream.getVideoTracks()[0], stream);
        const context = new AudioContext();
        const oscillator = context.createOscillator();
        const gain = context.createGain();
        gain.gain.value = 0;
        const destination = context.createMediaStreamDestination();
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        pc.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
        pc.ondatachannel = (event) => {
          event.channel.onmessage = (message) => {
            const value = JSON.parse(message.data);
            window.inputMessages.push({ id, value });
            if (value.type === 'control')
              event.channel.send(JSON.stringify({ control: value.enabled }));
          };
        };
        window.senders.set(id, { pc, timer, stream, context });
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
      { id, sdp },
    );
  },
  async stop(id) {
    await sender.evaluate(async (id) => {
      const active = window.senders?.get(id);
      if (!active) return;
      active.pc.close();
      clearInterval(active.timer);
      active.stream.getTracks().forEach((t) => t.stop());
      await active.context.close();
      window.senders.delete(id);
    }, id);
  },
};
const sessionStore = new SessionStore();
const approvedStore = await ApprovedClientStore.open(null, { keys: sessionStore.keys });
const server = createHttpApp({
  inventory: new DisplayInventory(displays),
  serverName: 'Thor',
  display: { width: 2560, height: 1440 },
  media,
  policy: { snapshot: () => structuredClone(policy), busy: false },
  sessionStore,
  approvedClients: approvedStore,
});
const sessionPassword = server.sessionStore.password;
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
if (process.argv.includes('--preview')) {
  console.log(`UI test fixture: ${url} — test password ${sessionPassword} (no desktop capture)`);
  await new Promise((resolve) => {
    process.on('SIGINT', resolve);
    process.on('SIGTERM', resolve);
  });
  await new Promise((resolve) => server.close(resolve));
  await browser.close();
  process.exit(0);
}
const output = 'out/web-client';
await mkdir(output, { recursive: true });
try {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 850 },
    colorScheme: 'light',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const authenticationPosts = [];
  page.on('request', (request) => {
    if (
      request.method() === 'POST' &&
      /\/api\/(?:key-start|connect|connection-key|approved-clients\/register)$/.test(request.url())
    )
      authenticationPosts.push({
        route: new URL(request.url()).pathname,
        body: request.postDataJSON(),
      });
  });
  await page.goto(url);
  await page.waitForFunction(() => document.getElementById('serverName').textContent === 'Thor');
  assert.equal(await page.locator('#connectForm input').count(), 1);
  assert.equal(await page.locator('.code-cells span').count(), 8);
  assert.equal(await page.locator('.code-dash').isVisible(), true);
  assert.equal(await page.locator('#streamProfile').isVisible(), false);
  await page.locator('#password').fill(' abcd-efgh ');
  assert.equal(await page.locator('#password').inputValue(), 'ABCD-EFGH');
  assert.deepEqual(await page.locator('.code-cells span').allTextContents(), [...'ABCDEFGH']);
  await page.locator('#password').press('Control+a');
  await page.waitForFunction(() => document.querySelectorAll('.code-cells .selected').length === 8);
  assert.equal(
    await page
      .locator('#password')
      .evaluate((el) => getComputedStyle(el, '::selection').backgroundColor),
    'rgba(0, 0, 0, 0)',
  );
  await page.screenshot({ path: `${output}/password-selection.png` });
  await page.locator('#password').press('Home');
  await page.locator('#password').press('Shift+ArrowRight');
  await page.locator('#password').press('Shift+ArrowRight');
  await page.waitForFunction(() => document.querySelectorAll('.code-cells .selected').length === 2);
  await page.keyboard.insertText('zz');
  assert.equal(await page.locator('#password').inputValue(), 'ZZCD-EFGH');
  assert.deepEqual(await page.locator('.code-cells span').allTextContents(), [...'ZZCDEFGH']);
  await page.locator('#password').fill('');
  await page.screenshot({ path: `${output}/pairing-light.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  assert.equal(
    await page.locator('html').evaluate((el) => getComputedStyle(el).colorScheme),
    'dark',
  );
  await page.locator('#appearance').selectOption('light');
  assert.equal(
    await page.locator('html').evaluate((el) => getComputedStyle(el).colorScheme),
    'light',
  );
  await page.reload();
  assert.equal(await page.locator('#appearance').inputValue(), 'light');
  await page.locator('#appearance').selectOption('system');
  assert.equal(
    await page.locator('html').evaluate((el) => getComputedStyle(el).colorScheme),
    'dark',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${output}/pairing-mobile-dark.png` });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.locator('#password').fill('AAAAAAAA');
  await page.locator('#connect').click();
  await page.waitForFunction(() =>
    document.getElementById('passwordError').textContent.includes('not recognized'),
  );
  await page.locator('#password').fill(sessionPassword);
  await page.locator('#connect').click();
  await page.waitForFunction(() => document.getElementById('video').videoWidth > 0, null, {
    timeout: 20000,
  });
  assert.equal(await page.locator('#password').inputValue(), '');
  assert.equal(offers.length, 1);
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: `${output}/viewer-light.png` });
  const rects = await page.evaluate(() =>
    ['stage', 'video'].map((id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return [r.width, r.height];
    }),
  );
  assert.deepEqual(rects[0], rects[1]);
  assert.ok(Math.abs(rects[0][0] / rects[0][1] - 16 / 9) < 0.01);
  await page.setViewportSize({ width: 1280, height: 1200 });
  await page.waitForFunction(() => document.getElementById('stage').clientWidth >= 1270);
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.waitForFunction(
    () => document.getElementById('stage').getBoundingClientRect().bottom <= innerHeight,
  );
  await page.setViewportSize({ width: 1280, height: 850 });
  await page.locator('#qualitySummary').click();
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/offer') && r.status() === 200),
    page.locator('input[name="streamProfile"][value="balanced"]').check(),
  ]);
  await page.waitForFunction(
    () =>
      document.getElementById('qualitySummary').textContent === 'Quality: Balanced' &&
      document.getElementById('video').videoWidth > 0,
  );
  assert.equal(offers.at(-1).profile.name, 'balanced');
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/offer') && r.status() === 200),
    page.getByRole('button', { name: /Second display/ }).click(),
  ]);
  await page.waitForFunction(() => document.getElementById('video').videoWidth > 0);
  assert.equal(offers.at(-1).display.id, displays[1].id);
  assert.equal(offers.at(-1).profile.name, 'balanced');
  assert.equal(await page.locator('#displayName').textContent(), 'Second display');
  await page.locator('#qualitySummary').click();
  assert.equal(await page.locator('#advancedQuality').isVisible(), false);
  assert.deepEqual(
    await page
      .locator('input[name="streamProfile"]')
      .evaluateAll((inputs) => inputs.map((i) => i.value)),
    ['auto', ...policy.profiles.filter((p) => p.enabled).map((p) => p.id)],
  );
  await page.screenshot({ path: `${output}/quality-light.png` });
  const compactWidth = (await page.locator('#qualityForm').boundingBox()).width;
  const optionSpacing = await page.locator('#qualityForm').evaluate((form) => {
    const rows = [...form.querySelectorAll('.profile-choice')].map((row) =>
      row.getBoundingClientRect(),
    );
    return {
      gaps: rows.slice(1).map((row, index) => row.top - rows[index].bottom),
      bottom: form.getBoundingClientRect().bottom - rows.at(-1).bottom,
    };
  });
  assert.ok(
    optionSpacing.gaps.every((gap) => gap <= 1),
    JSON.stringify(optionSpacing),
  );
  assert.ok(optionSpacing.bottom <= 8, JSON.stringify(optionSpacing));
  assert.ok(compactWidth < 320);
  assert.ok((await page.locator('.profile-choice').first().boundingBox()).height <= 48);
  // Intrinsic sizing grows with content, but never beyond the phone viewport.
  await page
    .locator('.profile-choice strong')
    .last()
    .evaluate((el) => {
      el.textContent = 'A longer host profile name for a larger desktop';
    });
  assert.ok((await page.locator('#qualityForm').boundingBox()).width > compactWidth);
  await page.setViewportSize({ width: 320, height: 844 });
  const phonePopup = await page.locator('#qualityForm').boundingBox();
  assert.ok(phonePopup.x >= 0 && phonePopup.x + phonePopup.width <= 320);
  await page.setViewportSize({ width: 1280, height: 850 });
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith('/api/offer') && r.status() === 200),
    page.locator('input[name="streamProfile"][value="auto"]').check(),
  ]);
  await page.waitForFunction(
    () =>
      document.getElementById('qualitySummary').textContent === 'Quality: Automatic' &&
      document.getElementById('video').videoWidth > 0,
  );
  await page.locator('#video').hover({ position: { x: 20, y: 1 } });
  await page.locator('#control').click();
  assert.equal(await page.locator('#control').getAttribute('aria-pressed'), 'true');
  const releasesBeforePictureInPicture = await sender.evaluate(
    () => window.inputMessages.filter(({ value }) => value.type === 'release').length,
  );
  await page.locator('#pictureInPicture').click();
  await page.waitForFunction(() => document.pictureInPictureElement?.id === 'video');
  await sender.waitForFunction(
    (before) =>
      window.inputMessages.filter(({ value }) => value.type === 'release').length > before,
    releasesBeforePictureInPicture,
    { timeout: 5000 },
  );
  assert.equal(
    await page.locator('#control').getAttribute('aria-pressed'),
    'false',
    'Entering picture-in-picture must relinquish remote control',
  );
  assert.equal(
    await page.locator('#control').isDisabled(),
    true,
    'Remote control must stay unavailable while picture-in-picture is active',
  );
  assert.match(
    await page.locator('#pictureInPicture').getAttribute('aria-label'),
    /^Exit picture-in-picture/,
  );
  await page.locator('#pictureInPicture').click();
  await page.waitForFunction(() => !document.pictureInPictureElement);
  assert.equal(
    await page.locator('#control').isDisabled(),
    false,
    'Leaving picture-in-picture must restore the session control eligibility',
  );
  await page.locator('#qualitySummary').click();
  assert.equal(await page.locator('#control').getAttribute('aria-pressed'), 'false');
  await page.locator('#qualitySummary').click();
  await page.locator('#video').hover({ position: { x: 20, y: 1 } });
  await page.locator('#fullscreen').click();
  await page.waitForFunction(() => document.fullscreenElement?.id === 'stage');
  assert.equal((await page.locator('#immersiveToolbar').boundingBox()).y, 0);
  await page.keyboard.press('Control+Shift+f');
  await page.waitForFunction(() => !document.fullscreenElement);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${output}/viewer-mobile-dark.png` });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.locator('#pictureInPicture').click();
  await page.waitForFunction(() => document.pictureInPictureElement?.id === 'video');
  await page.locator('#disconnect').click();
  await page.locator('#connect').waitFor({ state: 'visible' });
  assert.equal(
    await page.evaluate(() => document.pictureInPictureElement),
    null,
    'Disconnecting must close the picture-in-picture window',
  );
  assert.equal(server.sessionStore.list().length, 0);

  const setup = server.sessionStore.keys.createSetup({ ttlMs: 60_000 });
  await page.locator('#password').fill(setup.key);
  await page.locator('#connect').click();
  await page.locator('#registerForm').waitFor({ state: 'visible' });
  await page.locator('#deviceName').fill("Kim's browser");
  await page.locator('#registerUsername').fill('kim');
  await page.locator('#registerPassword').fill('correct horse battery staple');
  await page.locator('#confirmPassword').fill('correct horse battery staple');
  await page.locator('#requestApproval').click();
  await page.locator('#approvalPending').waitFor({ state: 'visible' });
  const pending = approvedStore.status().pending;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].username, 'kim');
  assert.equal(
    authenticationPosts.some((entry) => entry.route === '/api/key-start'),
    true,
  );
  assert.equal(
    authenticationPosts.some((entry) =>
      ['/api/connect', '/api/connection-key'].includes(entry.route),
    ),
    false,
  );
  const registrationPost = authenticationPosts.find(
    (entry) => entry.route === '/api/approved-clients/register',
  );
  assert.equal(typeof registrationPost.body.registrationTicket, 'string');
  assert.equal(Object.hasOwn(registrationPost.body, 'key'), false);
  await approvedStore.approve(pending[0].id);
  await page.locator('#signInForm').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await page.locator('#signInUsername').inputValue(), 'kim');
  const savedCredential = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('vidvnc-approved-client', 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const request = open.result.transaction('values').objectStore('values').get('credential');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        };
      }),
  );
  assert.equal(savedCredential.username, 'kim');
  assert.equal(JSON.stringify(savedCredential).includes('correct horse'), false);
  await page.locator('#signInPassword').fill('correct horse battery staple');
  await page.locator('#signIn').click();
  await page.waitForFunction(() => document.getElementById('video').videoWidth > 0, null, {
    timeout: 20000,
  });
  await page.locator('#disconnect').click();
  await page.locator('#signInForm').waitFor({ state: 'visible' });
  assert.equal(approvedStore.status().approved[0].connected, false);
  await page.locator('#useConnectionKey').click();
  await page.locator('#connectForm').waitFor({ state: 'visible' });

  const diagnosticsPage = await browser.newPage();
  let source = { ...displays[1], number: 2 };
  let sourceAge = 0;
  await diagnosticsPage.route('**/api/diagnostics', (route) =>
    route.fulfill({
      json: {
        configuration: {
          display: source,
          profile: { name: 'mobile', width: 1280, height: 720, fps: 15 },
          encoder: { label: 'NVIDIA NVENC', element: 'nvd3d11h265enc' },
        },
        serverAgeMs: sourceAge,
        clientAgeMs: null,
        server: {},
        client: {},
        history: [],
      },
    }),
  );
  await diagnosticsPage.goto(`${url}/diagnostics`);
  await diagnosticsPage.waitForFunction(
    () =>
      document.getElementById('source-display').textContent ===
      'Source display: 2 · Second display · 1920 × 1080',
  );
  await diagnosticsPage.waitForFunction(
    () =>
      document.getElementById('encoder').textContent === 'Encoder: NVIDIA NVENC · nvd3d11h265enc',
  );
  source = { ...displays[0], number: 1 };
  sourceAge = 5000;
  await diagnosticsPage.waitForFunction(
    () =>
      document.getElementById('source-display').textContent ===
      'Last selected source: 1 · Main display · 2560 × 1440 · Primary',
  );
  await diagnosticsPage.close();
  assert.deepEqual(errors, []);
  console.log(
    'PASS: connection-key editing/error recovery; approved-client registration and sign-in; responsive system/light/dark; width/height-fitted real WebRTC reception; automatic/approved profile reconnect; remote control release; picture-in-picture; fullscreen; disconnect.',
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  await Promise.all(offers.map(({ id }) => media.stop(id)));
  await browser.close();
}
