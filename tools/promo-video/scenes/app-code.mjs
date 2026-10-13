import { A, cursorSvg, ease, el, fade, lerp } from '../engine/kit.mjs';

// Scene: open the app, show a code.

export const build = (root) => {
  const a = el('shot', root, {
    width: '1006px',
    height: '850px',
    left: '457px',
    top: '50px',
    backgroundImage: `url(${A}mac/overview-dark.png)`,
  });
  const b = el('shot', root, {
    width: '1006px',
    height: '850px',
    left: '457px',
    top: '50px',
    backgroundImage: `url(${A}mac/connect-device-qr-dark.png)`,
  });
  const c = el('cursor', root, {}, cursorSvg);
  const cap = el(
    'abs',
    root,
    { left: 0, right: 0, top: '950px' },
    '<div class="title" style="font-size:52px">Open the app. Show a code.</div>',
  );
  return { a, b, c, cap };
};

export const update = ({ a, b, c }, lt, dur, root) => {
  root.style.opacity = fade(lt, dur, 0.4, 0.3);
  const s = 1006 / 1800;
  const tx = 457 + 1598 * s,
    ty = 50 + 303 * s;
  const m = ease((lt - 0.3) / 1.4);
  c.style.left = lerp(1200, tx, m) + 'px';
  c.style.top = lerp(800, ty, m) + 'px';
  c.style.transform = `scale(${lt > 1.8 && lt < 2 ? 0.85 : 1})`;
  b.style.opacity = ease((lt - 2.0) / 0.35);
  c.style.opacity = lt < 2.3 ? 1 : 0;
};
