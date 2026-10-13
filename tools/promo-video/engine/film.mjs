// The engine: loads every scene in one cut of the timeline (film.html?cut=consumer or
// developer), stacks them on one stage over the WebGL backdrop, and draws the film at any
// moment t. promo.mjs calls window.render(t) per frame.
import { cut } from '../timeline.mjs';
import { el, eqReady } from './kit.mjs';
import * as backdrop from './backdrop.mjs';

const params = new URLSearchParams(location.search);
const { scenes: SCENES, duration: DURATION } = cut(params.get('cut') || 'developer');
const STAGE = document.getElementById('stage');
const scenes = await Promise.all(
  SCENES.map(async (s) => ({ ...s, ...(await import(`../scenes/${s.file}`)) })),
);
for (const s of scenes) {
  s.root = el('scene', STAGE);
  s.st = s.build(s.root, s);
}

window.DURATION = DURATION;
window.render = function (t) {
  backdrop.render(t);
  for (const s of scenes) {
    const on = t >= s.start && t < s.end;
    s.root.style.display = on ? 'block' : 'none';
    if (on) s.update(s.st, t - s.start, s.end - s.start, s.root, s);
  }
};
// Ready once the fonts, the music's spectrum and every image are loaded.
const images = () =>
  [
    ...new Set(
      [...document.querySelectorAll('*')]
        .map((e) => (getComputedStyle(e).backgroundImage.match(/url\("?([^")]+)"?\)/) || [])[1])
        .filter(Boolean),
    ),
  ].map(
    (u) =>
      new Promise((r) => {
        const i = new Image();
        i.onload = i.onerror = r;
        i.src = u;
      }),
  );
window.ready = Promise.all([
  eqReady,
  document.fonts.load('20px "Instrument Sans"'),
  document.fonts.load('20px "JetBrains Mono"'),
  document.fonts.ready,
]).then(() => Promise.all(images()));
window.render(Number(params.get('t') || 0));
