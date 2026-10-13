import { cursorSvg, ease, el, fade, makePhone, setDesk, vidTime, winPos } from '../engine/kit.mjs';

// Scene: take control from the sofa. The keyboard and mouse switch on in the viewer's toolbar,
// then a finger drags a window: the finger is the mouse (README, "Viewing on an iPhone").

export const build = (root) => {
  const p = makePhone(root, 1180, 600);
  p.ph.style.left = (1920 - 1180) / 2 + 'px';
  p.ph.style.top = '180px';
  const cur = el('abs', p.ph, { width: '34px', height: '44px' }, cursorSvg);
  const finger = el('finger', p.ph);
  const chip = el(
    'abs',
    p.ph,
    {
      left: '50%',
      top: '40px',
      transform: 'translateX(-50%)',
      padding: '10px 22px',
      borderRadius: '24px',
      fontSize: '22px',
      fontWeight: 600,
      whiteSpace: 'nowrap',
      boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
    },
    'Keyboard and mouse',
  );
  const t = el(
    'abs',
    root,
    { left: 0, right: 0, top: '860px' },
    '<div class="title" style="font-size:56px">Take control from the sofa.</div><div class="sub" style="margin-top:12px">On a phone, your finger is the mouse.</div>',
  );
  return { p, cur, finger, chip, t };
};

export const update = ({ p, cur, finger, chip, t }, lt, dur, root, { start }) => {
  root.style.opacity = fade(lt, dur);
  const time = vidTime(start + lt);
  setDesk(p.desk, time, false, 'film'); // a film plays while you take control
  const on = lt > 1.6;
  chip.style.background = on ? '#2f6feb' : 'rgba(30,36,52,0.92)';
  chip.style.color = on ? '#fff' : '#a9b5ca';
  chip.style.opacity = ease((lt - 0.5) / 0.4) * (1 - ease((lt - 3.2) / 0.5));
  const w = winPos(time);
  const x = p.ox + (w.x + 280) * p.s,
    y = p.oy + (w.y + 19) * p.s;
  const drag = on && lt > 2.2;
  finger.style.opacity = drag ? 1 : 0;
  finger.style.left = x + 'px';
  finger.style.top = y + 'px';
  cur.style.opacity = on ? 1 : 0;
  cur.style.left = x + 6 + 'px';
  cur.style.top = y + 4 + 'px';
  t.style.opacity = ease((lt - 0.6) / 0.5);
};
