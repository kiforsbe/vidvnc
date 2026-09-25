// Local UI-only check: no desktop capture or remote input is started.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHttpApp } from '@vidvnc/server/http-app.mjs';
const { chromium } = createRequire(import.meta.url)(process.argv[2]);
const server = createHttpApp();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async (key) => {
    const admitted = await fetch('/api/key-start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    if (!admitted.ok) throw new Error('Toolbar fixture admission failed.');
    const response = await fetch('/viewer/fragment.html');
    if (!response.ok) throw new Error('Toolbar fixture viewer fragment unavailable.');
    const fragment = document.createElement('template');
    fragment.innerHTML = await response.text();
    document
      .getElementById('viewerHeaderMount')
      .replaceChildren(
        fragment.content.querySelector('#sessionIdentity'),
        fragment.content.querySelector('#disconnect'),
      );
    document
      .getElementById('viewerMount')
      .replaceChildren(fragment.content.querySelector('#viewer'));
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = '/viewer/style.css';
    document.head.append(style);
    await new Promise((resolve, reject) => {
      style.onload = resolve;
      style.onerror = reject;
    });
    const { createViewer } = await import('/viewer/app.js');
    createViewer({ onExit: () => {} });
  }, server.sessionStore.password);
  await page.waitForFunction(() => document.querySelector('#fullscreen svg'));
  await page.evaluate(() => {
    document.getElementById('welcome').hidden = true;
    document.getElementById('viewer').hidden = false;
    document.getElementById('immersiveToolbar').classList.add('visible');
  });
  await page.locator('#fullscreen').click();
  await page.waitForFunction(() => document.fullscreenElement?.id === 'stage');
  await page.waitForTimeout(250);
  const dock = page.locator('#immersiveToolbar');
  const rect = await dock.boundingBox();
  assert.equal(rect.y, 0, 'Fullscreen toolbar must meet the top edge exactly');
  assert.ok(rect.width < 200, 'Icon toolbar must remain compact');
  assert.equal(await dock.locator('button svg').count(), 4);
  assert.match(
    await page.locator('#pictureInPicture').getAttribute('aria-label'),
    /Picture-in-picture/,
  );
  assert.equal(await page.locator('#pictureInPicture').isDisabled(), true);
  assert.equal((await dock.innerText()).trim(), '', 'Buttons are icon-only');
  await page.locator('#audioToggle').click();
  assert.equal(await page.locator('#audioToggle').getAttribute('aria-pressed'), 'false');
  assert.match(await page.locator('#audioToggle').getAttribute('aria-label'), /Unmute/);
  assert.equal(await page.locator('#audioToggle svg').count(), 1);
  await page.locator('#video').focus();
  await page.mouse.move(20, 400);
  await page.waitForTimeout(3100);
  assert.equal(
    await dock.evaluate((el) => getComputedStyle(el).opacity),
    '0',
    'Video focus must not pin toolbar open',
  );
  await page.mouse.move(640, 1);
  await page.waitForTimeout(250);
  assert.equal(await dock.evaluate((el) => getComputedStyle(el).opacity), '1');
  await page.locator('#fullscreen').click();
  await page.waitForFunction(() => !document.fullscreenElement);
  assert.match(await page.locator('#fullscreen').getAttribute('aria-label'), /^Full screen/);
  assert.deepEqual(errors, []);
  console.log(
    'Toolbar passed: flush fullscreen position, icons, PiP readiness, mute state, auto-hide, edge reveal, fullscreen exit.',
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
