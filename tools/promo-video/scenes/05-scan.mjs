import { A, ease, el, fade, makeDesk, setDesk } from '../engine/kit.mjs';

// Scene 05: scan the code or type the key.

export const build = (root) => {
  const q = el('shot', root, {
    width: '900px',
    height: '760px',
    left: '170px',
    top: '160px',
    backgroundImage: `url(${A}mac/connect-device-qr-dark.png)`,
  });
  const ph = el('phone', root, {
    width: '420px',
    height: '860px',
    left: '1260px',
    top: '110px',
  });
  const scr = el('screen', ph);
  const cam = el('abs', scr, { inset: 0, background: '#1a1d24' });
  const qr = el('abs', cam, {
    left: '50px',
    top: '260px',
    width: '280px',
    height: '280px',
    backgroundImage: `url(${A}mac/connect-device-qr-dark.png)`,
    backgroundSize: `${(280 / 300) * 1800}px auto`,
    backgroundPosition: `-${(498 * 280) / 300}px -${(654 * 280) / 300}px`,
    borderRadius: '8px',
  });
  const frame = el('abs', cam, {
    left: '36px',
    top: '246px',
    width: '308px',
    height: '308px',
    border: '4px solid #ffd43b',
    borderRadius: '22px',
  });
  const view = el('abs', scr, { inset: 0, background: '#000' });
  // the portrait phone gets a tall desk that fills its screen
  const s = 380 / 800;
  const holder = el('abs', view, {
    left: 0,
    top: 0,
    width: '380px',
    height: '820px',
    overflow: 'hidden',
  });
  const desk = makeDesk(holder, 800, Math.round(820 / s));
  desk.root.style.transform = `scale(${s})`;
  const url = el(
    'abs',
    view,
    {
      left: '20px',
      right: '20px',
      bottom: '28px',
      height: '44px',
      borderRadius: '22px',
      background: '#2b2f38',
      color: '#cfd6e4',
      fontSize: '18px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
    },
    '192.168.1.24',
  );
  const t = el(
    'abs',
    root,
    { left: 0, right: 0, top: '40px' },
    '<div class="title" style="font-size:56px">Scan the code, or type the key.</div>',
  );
  // the typed alternative: the short key next to the QR code
  const key = el('abs', root, {
    left: '590px',
    top: '462px',
    width: '130px',
    height: '56px',
    border: '4px solid #ffd43b',
    borderRadius: '12px',
    boxSizing: 'border-box',
  });
  return { q, ph, cam, frame, view, desk, t, key };
};

export const update = ({ q, ph, cam, frame, view, desk, t, key }, lt, dur, root, { start }) => {
  root.style.opacity = fade(lt, dur);
  frame.style.opacity = lt > 1 ? (Math.floor(lt * 6) % 2 ? 1 : 0.6) : 0;
  view.style.opacity = ease((lt - 2.2) / 0.4);
  key.style.opacity = ease((lt - 2.6) / 0.4);
  setDesk(desk, start + lt);
  t.style.opacity = ease((lt - 2.4) / 0.5);
};
