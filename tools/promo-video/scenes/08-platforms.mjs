import { A, el, fade, lerp } from '../engine/kit.mjs';

// Scene 08: both platforms.

export const build = (root) => {
  const imgs = [
    ['win/overview-light.png', 986, 713],
    ['mac/overview-light.png', 1800, 1520],
    ['win/overview-dark.png', 986, 713],
    ['mac/overview-dark.png', 1800, 1520],
  ];
  const shots = imgs.map(([f, w, h]) => {
    const H = 820,
      W = (H * w) / h;
    return el('shot', root, {
      width: W + 'px',
      height: H + 'px',
      left: (1920 - W) / 2 + 'px',
      top: '60px',
      backgroundImage: `url(${A}${f})`,
      borderRadius: '14px',
    });
  });
  const cap = el(
    'abs',
    root,
    { left: 0, right: 0, top: '930px' },
    '<div class="title" style="font-size:52px">Mac and Windows. Hardware encoding on both.</div>',
  );
  return { shots, cap };
};

export const update = ({ shots }, lt, dur, root) => {
  root.style.opacity = fade(lt, dur, 0.3, 0.4);
  const i = Math.min(3, Math.floor(lt / 1.25));
  shots.forEach((s, k) => {
    s.style.display = k === i ? 'block' : 'none';
    s.style.transform = `scale(${lerp(0.97, 1.01, (lt % 1.25) / 1.25)})`;
  });
};
