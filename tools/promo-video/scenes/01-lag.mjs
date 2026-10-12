import { ease, el, fade, lerp, makePhone, setDesk, vncTime, winPos } from '../engine/kit.mjs';

// Scene 01: the lag everyone knows.

export const build = (root) => {
  const p = makePhone(root, 1180, 600);
  p.ph.style.left = (1920 - 1180) / 2 + 'px';
  p.ph.style.top = '200px';
  const finger = el('finger', p.ph);
  const text = el(
    'abs',
    root,
    { left: 0, right: 0, top: '880px' },
    '<div class="title">Every frame, a beat behind.</div>',
  );
  el('note', root, {}, 'Illustration');
  return { p, finger, text };
};

export const update = ({ p, finger, text }, lt, dur, root) => {
  root.style.opacity = fade(lt, dur, 0.6, 0.3);
  const on = ease((lt - 0.6) / 0.6);
  p.screen.style.opacity = on;
  setDesk(p.desk, vncTime(lt));
  p.desk.root.style.filter = 'blur(1.2px) saturate(0.85)';
  const w = winPos(lt);
  finger.style.left = p.ox + (w.x + 280) * p.s + 'px';
  finger.style.top = p.oy + (w.y + 19) * p.s + 'px';
  finger.style.opacity = lt > 3 ? 1 : 0;
  text.style.opacity = ease((lt - 8) / 0.6);
  p.ph.style.transform = `scale(${lerp(1, 0.96, ease((lt - 8) / 1))})`;
};
