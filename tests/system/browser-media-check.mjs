// Opt-in real desktop capture/WebRTC smoke test. Pass the installed Playwright
// module directory as argv[2]. Chromium with an iPhone UA tests profile routing,
// not Safari, iOS hardware decoding, or Wi-Fi behavior.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createHttpApp } from '@vidvnc/server/http-app.mjs';
import { NativeMedia } from '@vidvnc/server/native-media.mjs';
import { Diagnostics } from '@vidvnc/server/diagnostics.mjs';
import { SessionStore } from '@vidvnc/server/session-store.mjs';
const { chromium } = createRequire(import.meta.url)(process.argv[2]);
const diagnostics = new Diagnostics();
const store = new SessionStore();
const media = new NativeMedia({ diagnostics, onExit: (id) => store.disconnect(id) });
const offer = media.offer.bind(media);
let negotiatedRtx = false;
media.offer = async (...args) => {
  try {
    const answer = await offer(...args);
    negotiatedRtx =
      /a=rtpmap:\d+ rtx\/90000/i.test(args[1]) && /a=rtpmap:\d+ rtx\/90000/i.test(answer);
    return answer;
  } catch (error) {
    console.error('Negotiation:', error.message);
    throw error;
  }
};
const server = createHttpApp({ sessionStore: store, media, diagnostics });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  for (const audio of [false, true]) {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X)',
    });
    const page = await context.newPage();
    if (process.argv.includes('--media-debug')) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Media.enable');
      for (const event of ['playerErrorsRaised', 'playerMessagesLogged', 'playerEventsAdded'])
        cdp.on(`Media.${event}`, (data) => console.log(event, JSON.stringify(data)));
    }
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') console.error('Browser:', message.text());
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('#password').fill(store.password);
    await page.locator('#shareAudio').setChecked(audio);
    if (process.argv[3]) await page.locator('#streamProfile').selectOption(process.argv[3]);
    await page.locator('#connect').click();
    let sample;
    for (let attempt = 0; attempt < 25; attempt++) {
      await delay(1000);
      sample = diagnostics.snapshot();
      if (sample.client?.framesDecoded > 40 && (!audio || sample.client.audioPacketsReceived > 30))
        break;
    }
    assert.deepEqual(errors, []);
    assert.equal(negotiatedRtx, true, 'Both offer and answer must negotiate RTX');
    assert.ok(sample.server.videoRtpPackets > 0, 'RTP probe must see video packets');
    assert.ok(sample.server.iceInputPackets > 0, 'ICE probe must see transport packets');
    assert.ok(sample.server.rtxSenders > 0, 'Sender must expose the retransmission element');
    assert.ok(sample.client?.framesDecoded > 40, await page.locator('#status').textContent());
    console.log('Presentation diagnostic:', JSON.stringify(sample.client));
    await page.waitForFunction(() => document.getElementById('video').videoWidth > 0, null, {
      timeout: 10000,
    });
    const geometry = await page.locator('#video').evaluate((video) => {
      const stage = video.parentElement.getBoundingClientRect();
      return {
        width: stage.width,
        height: stage.height,
        ratio: video.videoWidth / video.videoHeight,
        paused: video.paused,
        ready: video.readyState,
        tracks: video.srcObject
          ?.getTracks()
          .map((t) => ({ kind: t.kind, muted: t.muted, enabled: t.enabled, state: t.readyState })),
        html: video.outerHTML,
        videoRect: JSON.stringify(video.getBoundingClientRect()),
        display: getComputedStyle(video).display,
      };
    });
    assert.ok(
      Math.abs(geometry.width / geometry.height - geometry.ratio) < 0.01,
      'Windowed stage must fit the video aspect ratio: ' + JSON.stringify(geometry),
    );
    assert.equal(geometry.paused, false);
    await page.locator('#immersiveToolbar').evaluate((el) => el.classList.add('visible'));
    await page.locator('#fullscreen').click();
    await page.waitForFunction(() => document.fullscreenElement?.id === 'stage');
    assert.ok(
      await page
        .locator('#video')
        .evaluate((video) => video.getBoundingClientRect().height > 100 && !video.paused),
    );
    await page.locator('#fullscreen').click();
    await page.waitForFunction(() => !document.fullscreenElement);
    assert.equal(sample.server.spsProfile, 66);
    assert.equal(sample.server.spsLevel, 31);
    assert.equal(sample.configuration.profile.name, process.argv[3] || 'iphone-720p-test');
    assert.equal(sample.configuration.audio.enabled, audio);
    const performancePage = await context.newPage();
    await performancePage.goto(`http://127.0.0.1:${server.address().port}/diagnostics`);
    await performancePage.waitForFunction(() =>
      document.getElementById('profile').textContent.startsWith('Current profile:'),
    );
    assert.match(
      await performancePage.locator('#profile').textContent(),
      new RegExp(sample.configuration.profile.name),
    );
    assert.match(
      await performancePage.locator('#profile-settings').textContent(),
      audio ? /Opus 32 kbit\/s mono/ : /Audio off/,
    );
    await performancePage.close();
    assert.equal(sample.client.frameWidth, process.argv[3] === 'low-bandwidth' ? 960 : 1280);
    if (audio) assert.ok(sample.client.audioPacketsReceived > 30);
    else assert.equal(sample.server.audioEncodedPackets, 0);
    console.log(
      JSON.stringify({
        audio,
        decoded: sample.client.framesDecoded,
        fps: sample.client.decodeFps,
        audioPackets: sample.client.audioPacketsReceived,
        spsLevel: sample.server.spsLevel,
        icePeak1ms: sample.server.iceInputPeak1msBytes,
        rtxSenders: sample.server.rtxSenders,
        rtxRequests: sample.server.rtxRequests,
      }),
    );
    await page.locator('#disconnect').click();
    await context.close();
    for (let i = 0; media.active && i < 50; i++) await delay(100);
    assert.equal(media.active, null);
  }
} finally {
  store.stop();
  await media.shutdown();
  await browser?.close();
  await new Promise((r) => server.close(r));
}
