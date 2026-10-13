import { A, ease, el, fade, lerp } from '../engine/kit.mjs';

// Scene: registered devices sign in with a username and password.
// The host approves a device once (Connections, Approved Clients); after that it signs in
// with a username and password, without a key. Passkeys are future work (README).

const field = (parent, top, label) => {
  el('abs', parent, { left: '28px', top: top + 'px', fontSize: '17px', color: '#a9b5ca' }, label);
  return el('abs mono', parent, {
    left: '28px',
    right: '28px',
    top: top + 28 + 'px',
    height: '52px',
    borderRadius: '12px',
    background: '#1f2533',
    border: '2px solid #2f3a52',
    boxSizing: 'border-box',
    padding: '0 16px',
    display: 'flex',
    alignItems: 'center',
    fontSize: '22px',
    color: '#e6ebf5',
  });
};

export const build = (root) => {
  const W = 900,
    s = W / 1800;
  const shot = el('shot', root, {
    width: W + 'px',
    height: 1520 * s + 'px',
    left: '150px',
    top: '190px',
    backgroundImage: `url(${A}mac/connections-dark.png)`,
  });
  // the Approved Clients list
  const hl = el('hl', root, {
    left: 150 + 460 * s - 8 + 'px',
    top: 190 + 380 * s - 8 + 'px',
    width: 1300 * s + 16 + 'px',
    height: 262 * s + 16 + 'px',
  });
  const ph = el('phone', root, { width: '420px', height: '860px', left: '1300px', top: '150px' });
  const scr = el('screen', ph, { background: '#0d1322' });
  el(
    'abs',
    scr,
    { left: 0, right: 0, top: '120px', textAlign: 'center', fontSize: '34px', fontWeight: 600 },
    'Sign in to VidVNC',
  );
  const user = field(scr, 230, 'Username');
  const pass = field(scr, 330, 'Password');
  const btn = el(
    'abs',
    scr,
    {
      left: '28px',
      right: '28px',
      top: '450px',
      height: '56px',
      borderRadius: '12px',
      background: '#2f6feb',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '22px',
      fontWeight: 600,
    },
    'Sign in',
  );
  const soon = el(
    'abs',
    scr,
    {
      left: '28px',
      right: '28px',
      top: '540px',
      height: '52px',
      borderRadius: '12px',
      border: '2px dashed #3f4a63',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontSize: '19px',
      color: '#8693ab',
    },
    'Passkeys: coming in a later release',
  );
  const t = el(
    'abs',
    root,
    { left: 0, right: 0, top: '50px' },
    '<div class="title" style="font-size:56px">Or register once, then sign in.</div>',
  );
  return { shot, hl, ph, user, pass, btn, soon, t };
};

export const update = ({ shot, hl, ph, user, pass, btn, soon, t }, lt, dur, root) => {
  root.style.opacity = fade(lt, dur);
  t.style.opacity = ease((lt - 0.3) / 0.5);
  hl.style.opacity = ease((lt - 0.8) / 0.5);
  shot.style.transform = `scale(${lerp(1, 1.02, lt / dur)})`;
  ph.style.transform = `translateY(${lerp(30, 0, ease(lt / 0.8))}px)`;
  // typing the username, then the password, then signing in
  const name = 'sam';
  user.textContent = name.slice(0, Math.floor(clampN((lt - 1.8) / 0.15, 0, name.length)));
  pass.textContent = '•'.repeat(Math.floor(clampN((lt - 2.6) / 0.09, 0, 10)));
  const press = lt > 3.8 && lt < 4.1;
  btn.style.transform = press ? 'scale(0.97)' : 'none';
  btn.style.filter = press ? 'brightness(0.85)' : 'none';
  soon.style.opacity = ease((lt - 6.4) / 0.5); // as the voice says it
};
const clampN = (v, a, b) => Math.min(b, Math.max(a, v));
