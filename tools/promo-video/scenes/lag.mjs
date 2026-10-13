import { ease, el, fade, lerp, makePhone, setDesk, vncTime, winPos } from '../engine/kit.mjs';

// Scene: the lag everyone knows. opts.label names what is lagging; the title comes in for
// the last two seconds.

export const build = (root, { opts }) => {
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
  const label = el(
    'label',
    root,
    { left: 0, width: '1920px', top: '120px', color: '#a9b5ca' },
    opts.label,
  );
  return { p, finger, text, label };
};

export const update = ({ p, finger, text, label }, lt, dur, root) => {
  root.style.opacity = fade(lt, dur, 0.6, 0.3);
  const on = ease((lt - 0.6) / 0.6);
  p.screen.style.opacity = on;
  label.style.opacity = on;
  setDesk(p.desk, vncTime(lt));
  p.desk.root.style.filter = 'blur(1.2px) saturate(0.85)';
  const w = winPos(lt);
  finger.style.left = p.ox + (w.x + 280) * p.s + 'px';
  finger.style.top = p.oy + (w.y + 19) * p.s + 'px';
  finger.style.opacity = lt > Math.min(3, dur * 0.25) ? 1 : 0;
  const tt = dur - 2.2;
  text.style.opacity = ease((lt - tt) / 0.6);
  p.ph.style.transform = `scale(${lerp(1, 0.96, ease((lt - tt) / 1))})`;
};
