import { ease, el, fade, lerp, makeDesk, makeLaptop, makePhone, setDesk } from '../engine/kit.mjs';

// Scene 12: every device, one desktop.

export const build = (root) => {
  const lap = makeLaptop(root, 760);
  lap.box.style.left = '120px';
  lap.box.style.top = '250px';
  const s1 = 716 / 1600;
  const h1 = el('abs', lap.screen, {
    left: 0,
    top: (442 - 1000 * s1) / 2 + 'px',
    width: '716px',
    height: 1000 * s1 + 'px',
    overflow: 'hidden',
  });
  const d1 = makeDesk(h1);
  d1.root.style.transform = `scale(${s1})`;
  const tab = makePhone(root, 620, 440);
  tab.ph.style.left = '960px';
  tab.ph.style.top = '240px';
  tab.ph.style.borderRadius = '40px';
  const ph = makePhone(root, 560, 290);
  ph.ph.style.left = '1240px';
  ph.ph.style.top = '560px';
  const t = el(
    'abs',
    root,
    { left: 0, right: 0, top: '900px' },
    '<div class="title" style="font-size:72px">VidVNC</div>',
  );
  return { d1, tab, ph, t };
};

export const update = ({ d1, tab, ph, t }, lt, dur, root, { start }) => {
  root.style.opacity = fade(lt, dur, 0.4, 0.4);
  const time = start + lt;
  setDesk(d1, time);
  setDesk(tab.desk, time - 0.06);
  setDesk(ph.desk, time - 0.07);
  root.style.transform = `scale(${lerp(1.08, 1, ease(lt / 3))})`;
  t.style.opacity = ease((lt - 1) / 0.6);
};
