import {
  clamp,
  ease,
  el,
  eqAt,
  fade,
  lerp,
  makePhone,
  setDesk,
  speakerOff,
  speakerOn,
  vidTime,
  vncTime,
  winPos,
} from '../engine/kit.mjs';

// Scene 02: the race: traditional VNC against VidVNC, with sound.

export const build = (root) => {
  const make = (x, label, color, icon) => {
    const p = makePhone(root, 860, 430);
    p.ph.style.left = x + 'px';
    p.ph.style.top = '300px';
    const f = el('finger', p.ph);
    const l = el('label', root, { left: x + 'px', width: '860px', top: '220px', color }, label);
    const ic = el('abs', root, { left: x + 403 + 'px', top: '770px' }, icon);
    return { p, f, l, ic };
  };
  const L = make(80, 'Traditional VNC', '#a9b5ca', speakerOff);
  const R = make(980, 'VidVNC', '#8db8ff', speakerOn);
  el('note', root, {}, 'Illustration · the 63 ms figure is measured');
  return { L, R };
};

export const update = ({ L, R }, lt, dur, root) => {
  root.style.opacity = fade(lt, dur, 0.4, 0.4);
  const t = lt + 12;
  const slide = ease(lt / 0.9);
  L.p.ph.style.transform = `translateX(${lerp(300, 0, slide)}px)`;
  R.p.ph.style.transform = `translateX(${lerp(-300, 0, slide)}px)`;
  [L.l, R.l, L.ic, R.ic].forEach((e) => (e.style.opacity = ease((lt - 0.8) / 0.5)));
  setDesk(L.p.desk, vncTime(t), true);
  L.p.desk.root.style.filter = 'blur(1.2px) saturate(0.85)';
  setDesk(R.p.desk, vidTime(t), true);
  const w = winPos(t);
  for (const s of [L, R]) {
    s.f.style.left = s.p.ox + (w.x + 280) * s.p.s + 'px';
    s.f.style.top = s.p.oy + (w.y + 19) * s.p.s + 'px';
  }
  const waves = R.ic.querySelectorAll('path');
  const level = eqAt(vidTime(t))[48]; // the speaker moves with the track you hear
  waves[1].style.opacity = 0.3 + 0.7 * level;
  waves[2].style.opacity = clamp(1.4 * level - 0.3, 0.15, 1);
};
