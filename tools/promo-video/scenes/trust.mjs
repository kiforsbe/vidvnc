import { ease, el, fade, lerp, monitorSvg } from '../engine/kit.mjs';

// Scene: the turn to trust.

export const build = (root) => {
  const mon = el(
    'abs',
    root,
    {
      left: '840px',
      top: '300px',
      width: '240px',
      height: '220px',
      filter: 'drop-shadow(0 0 30px rgba(47,111,235,0.8))',
    },
    monitorSvg('#8db8ff'),
  );
  const t1 = el(
    'abs',
    root,
    { left: 0, right: 0, top: '620px' },
    '<div class="title">Fast is easy. Trusted is the hard part.</div>',
  );
  return { mon, t1 };
};

export const update = ({ mon, t1 }, lt, dur, root) => {
  root.style.opacity = fade(lt, dur, 0.5, 0.5);
  t1.style.opacity = ease((lt - 0.4) / 0.6);
  mon.style.transform = `scale(${lerp(0.9, 1, ease(lt / 3))})`;
};
