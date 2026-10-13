// The shared kit every scene draws with: timing helpers, the shared desktop, devices and
// common shots. Everything is a pure function of time, so any frame renders on its own.
export const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const ease = (x) => {
  x = clamp(x);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
export const lerp = (a, b, x) => a + (b - a) * x;
export const fade = (lt, dur, fi = 0.4, fo = 0.4) =>
  clamp(Math.min(fi ? lt / fi : 1, fo ? (dur - lt) / fo : 1));
export function el(cls, parent, css = {}, html = '') {
  const e = document.createElement('div');
  e.className = cls;
  Object.assign(e.style, css);
  if (html) e.innerHTML = html;
  parent.appendChild(e);
  return e;
}
export const A = 'assets/';

/* ---------- the shared desktop, drawn at any moment ---------- */
// The desktop is a canvas: a wallpaper, a menu bar with a clock, and a music player
// whose visualiser plays eq.json, the spectrum of the track heard in the film (music.py).
// Each desk draws at its own clock, so a late desk shows late pictures.
let EQ = null; // { fps, bands, data: Uint8Array of frames x (bands + 1) }
export const eqReady = fetch('eq.json')
  .then((r) => (r.ok ? r.json() : null))
  .then((j) => {
    if (j) EQ = { ...j, data: Uint8Array.from(atob(j.data), (c) => c.charCodeAt(0)) };
  })
  .catch(() => {});
export function eqAt(time) {
  const n = 49;
  const out = new Float32Array(n);
  if (!EQ) return out;
  const frames = EQ.data.length / n;
  const x = clamp(time * EQ.fps, 0, frames - 1.001);
  const i = Math.floor(x),
    k = x - i;
  for (let b = 0; b < n; b++)
    out[b] = (EQ.data[i * n + b] * (1 - k) + EQ.data[(i + 1) * n + b] * k) / 255;
  return out;
}
// The wallpaper is drawn once: deep blue with soft light and silk-like ribbons.
export const WALL = (() => {
  const c = document.createElement('canvas');
  c.width = 1600;
  c.height = 1000;
  const g = c.getContext('2d');
  const bg = g.createLinearGradient(0, 0, 1600, 1000);
  bg.addColorStop(0, '#121a3d');
  bg.addColorStop(0.55, '#1a1446');
  bg.addColorStop(1, '#0a1026');
  g.fillStyle = bg;
  g.fillRect(0, 0, 1600, 1000);
  for (const [x, y, r, col] of [
    [380, 260, 620, '59,91,219'],
    [1250, 780, 680, '112,72,232'],
    [1100, 160, 420, '21,170,191'],
  ]) {
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `rgba(${col},0.55)`);
    rg.addColorStop(1, `rgba(${col},0)`);
    g.fillStyle = rg;
    g.fillRect(0, 0, 1600, 1000);
  }
  g.globalCompositeOperation = 'screen';
  for (let i = 0; i < 46; i++) {
    const k = i / 45;
    const lg = g.createLinearGradient(0, 0, 1600, 0);
    lg.addColorStop(0, `rgba(77,171,247,0)`);
    lg.addColorStop(0.35, `rgba(77,171,247,${0.05 + 0.1 * Math.sin(k * Math.PI)})`);
    lg.addColorStop(0.7, `rgba(151,117,250,${0.05 + 0.12 * Math.sin(k * Math.PI)})`);
    lg.addColorStop(1, `rgba(151,117,250,0)`);
    g.strokeStyle = lg;
    g.lineWidth = 1.5 + 2.5 * Math.sin(k * Math.PI);
    g.beginPath();
    for (let x = -20; x <= 1620; x += 20) {
      const y =
        560 +
        (k - 0.5) * 260 +
        Math.sin(x / 260 + k * 2.2) * (90 + 60 * k) +
        Math.sin(x / 120 + k * 5) * 18;
      x < 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
  }
  return c;
})();
export const rrect = (g, x, y, w, h, r) => {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
};
export const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
// The player window, in desk pixels.
// The player window, in desk pixels from the right edge; desks can be wider than 1600
// so they fill a wide phone screen.
export const PL = { right: 60, y: 230, w: 680, h: 640 };
// playing: whether the player is playing; the film only plays the desktop's song in the race.
// content 'film' swaps the music player for a window playing the film (drawFilm).
export function drawDesk(g, time, W, H, playing, content = 'player') {
  const eq = playing ? eqAt(time) : new Float32Array(49);
  const level = eq[48];
  const k = Math.max(W / 1600, H / 1000); // the wallpaper covers any desk size
  g.drawImage(WALL, (W - 1600 * k) / 2, (H - 1000 * k) / 2, 1600 * k, 1000 * k);
  // menu bar and clock
  g.fillStyle = 'rgba(8,12,26,0.6)';
  g.fillRect(0, 0, W, 36);
  g.fillStyle = '#e6ebf5';
  g.font = '600 20px "Instrument Sans"';
  g.textBaseline = 'middle';
  const pad = W === 1600 ? 22 : W > 1600 ? 120 : 90; // clear a phone screen's rounded corners
  g.fillText('Music', pad, 18);
  g.font = '20px "Instrument Sans"';
  ['File', 'Edit', 'View', 'Window'].forEach((m, i) => g.fillText(m, pad + 78 + i * 70, 18));
  // tenths of a second, so a late desk shows a different time
  const clock = 21 * 3600 + 41 * 60 + 12 + time;
  g.textAlign = 'right';
  g.font = '20px "JetBrains Mono"';
  g.fillText(
    `${Math.floor(clock / 3600) % 24}:${String(Math.floor(clock / 60) % 60).padStart(2, '0')}:${String(Math.floor(clock) % 60).padStart(2, '0')}.${Math.floor(clock * 10) % 10}`,
    W - pad,
    18,
  );
  g.textAlign = 'left';
  if (content === 'film') return drawFilmWindow(g, time, W, H);
  // player window
  const { w, h } = PL;
  const y = H > 1000 ? 150 : PL.y; // a tall (portrait) desk puts the player at the top
  const x = W - PL.right - w;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.55)';
  g.shadowBlur = 60;
  g.shadowOffsetY = 24;
  rrect(g, x, y, w, h, 22);
  g.fillStyle = 'rgba(16,20,34,0.92)';
  g.fill();
  g.restore();
  g.save();
  rrect(g, x, y, w, h, 22);
  g.clip();
  // title bar
  g.fillStyle = 'rgba(255,255,255,0.04)';
  g.fillRect(x, y, w, 52);
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
    g.fillStyle = c;
    g.beginPath();
    g.arc(x + 30 + i * 26, y + 26, 8, 0, 7);
    g.fill();
  });
  g.fillStyle = '#a9b5ca';
  g.font = '500 20px "Instrument Sans"';
  g.textAlign = 'center';
  g.fillText('Now Playing', x + w / 2, y + 27);
  g.textAlign = 'left';
  // cover art: glowing rings that breathe with the music
  const ax = x + 36,
    ay = y + 84,
    as = 230;
  const cg = g.createLinearGradient(ax, ay, ax + as, ay + as);
  cg.addColorStop(0, '#3b5bdb');
  cg.addColorStop(0.6, '#7048e8');
  cg.addColorStop(1, '#e64980');
  rrect(g, ax, ay, as, as, 16);
  g.fillStyle = cg;
  g.fill();
  g.save();
  rrect(g, ax, ay, as, as, 16);
  g.clip();
  g.globalCompositeOperation = 'screen';
  for (let r = 0; r < 7; r++) {
    g.strokeStyle = `rgba(255,255,255,${0.1 + 0.25 * level * (1 - r / 7)})`;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(ax + as * 0.5, ay + as * 0.62, 30 + r * 26 + level * 14, 0, 7);
    g.stroke();
  }
  g.restore();
  g.fillStyle = '#fff';
  g.font = '700 30px "Instrument Sans"';
  g.fillText('NIGHT', ax + 22, ay + 44);
  g.fillText('DRIVE', ax + 22, ay + 78);
  // track details
  const tx = ax + as + 34;
  g.fillStyle = '#fff';
  g.font = '600 44px "Instrument Sans"';
  g.fillText('Night Drive', tx, ay + 52);
  g.fillStyle = '#a9b5ca';
  g.font = '28px "Instrument Sans"';
  g.fillText('Demo track', tx, ay + 98);
  g.font = '22px "JetBrains Mono"';
  g.fillStyle = '#8db8ff';
  g.fillText('STEREO', tx, ay + 150);
  // level meters (left and right)
  for (let c = 0; c < 2; c++) {
    const mw = 300 * clamp(level * (c ? 0.97 : 1));
    rrect(g, tx, ay + 178 + c * 26, 300, 12, 6);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fill();
    const mg = g.createLinearGradient(tx, 0, tx + 300, 0);
    mg.addColorStop(0, '#15aabf');
    mg.addColorStop(0.7, '#4dabf7');
    mg.addColorStop(1, '#9775fa');
    rrect(g, tx, ay + 178 + c * 26, Math.max(12, mw), 12, 6);
    g.fillStyle = mg;
    g.fill();
  }
  // spectrum: 48 bars with a soft reflection
  const sx = x + 36,
    sw = w - 72,
    base = y + 500,
    bw = sw / 48;
  const sg = g.createLinearGradient(0, base - 140, 0, base);
  sg.addColorStop(0, '#9775fa');
  sg.addColorStop(0.5, '#4dabf7');
  sg.addColorStop(1, '#15aabf');
  g.save();
  g.shadowColor = 'rgba(77,171,247,0.7)';
  g.shadowBlur = 18;
  g.fillStyle = sg;
  for (let b = 0; b < 48; b++) {
    const bh = 6 + 134 * eq[b];
    rrect(g, sx + b * bw + 2, base - bh, bw - 4, bh, 3);
    g.fill();
  }
  g.restore();
  g.globalAlpha = 0.18;
  g.fillStyle = sg;
  for (let b = 0; b < 48; b++) {
    const bh = (6 + 134 * eq[b]) * 0.35;
    g.fillRect(sx + b * bw + 2, base + 4, bw - 4, bh);
  }
  g.globalAlpha = 1;
  // transport
  const el0 = playing ? 72 + time : 84; // paused: the position stays
  const total = 228;
  const py = y + 570;
  rrect(g, sx, py, sw, 8, 4);
  g.fillStyle = 'rgba(255,255,255,0.12)';
  g.fill();
  rrect(g, sx, py, sw * ((el0 % total) / total), 8, 4);
  g.fillStyle = '#e6ebf5';
  g.fill();
  g.font = '20px "JetBrains Mono"';
  g.fillStyle = '#a9b5ca';
  g.fillText(mmss(el0 % total), sx, py + 36);
  g.textAlign = 'right';
  g.fillText(mmss(total), sx + sw, py + 36);
  g.textAlign = 'left';
  // pause button while playing, play button while paused
  g.fillStyle = '#fff';
  if (playing) {
    g.fillRect(x + w / 2 - 14, py + 20, 9, 30);
    g.fillRect(x + w / 2 + 5, py + 20, 9, 30);
  } else {
    g.beginPath();
    g.moveTo(x + w / 2 - 10, py + 20);
    g.lineTo(x + w / 2 + 16, py + 35);
    g.lineTo(x + w / 2 - 10, py + 50);
    g.fill();
  }
  g.restore();
}
// A window playing the film where the player would be, with a title bar.
function drawFilmWindow(g, time, W, H) {
  const w = PL.w,
    fh = Math.round((w * 9) / 16),
    h = fh + 52;
  const x = W - PL.right - w,
    y = H > 1000 ? 150 : PL.y;
  g.save();
  g.shadowColor = 'rgba(0,0,0,0.55)';
  g.shadowBlur = 60;
  g.shadowOffsetY = 24;
  rrect(g, x, y, w, h, 22);
  g.fillStyle = 'rgba(16,20,34,0.96)';
  g.fill();
  g.restore();
  g.save();
  rrect(g, x, y, w, h, 22);
  g.clip();
  ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
    g.fillStyle = c;
    g.beginPath();
    g.arc(x + 30 + i * 26, y + 26, 8, 0, 7);
    g.fill();
  });
  g.fillStyle = '#a9b5ca';
  g.font = '500 20px "Instrument Sans"';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('Coastline', x + w / 2, y + 27);
  g.textAlign = 'left';
  g.translate(x, y + 52);
  drawFilm(g, time, w, fh);
  g.restore();
}
// A desk is 1600 x 1000 desk pixels unless a screen needs it wider or taller to fill it.
export function makeDesk(parent, W = 1600, H = 1000) {
  const root = el('desk', parent, { width: W + 'px', height: H + 'px' });
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  cv.style.position = 'absolute';
  root.appendChild(cv);
  const win = el('win', root, { backgroundImage: `url(${A}mac/overview-dark.png)` });
  return { root, g: cv.getContext('2d'), win, W, H };
}
export const winPos = (time) => ({
  x: 60 + 200 * (0.5 - 0.5 * Math.cos(time * 1.15)),
  y: 90 + 110 * (0.5 - 0.5 * Math.cos(time * 0.83)),
});
export function setDesk(d, time, playing = false, content = 'player') {
  drawDesk(d.g, time, d.W, d.H, playing, content);
  const p = winPos(time);
  d.win.style.left = p.x + 'px';
  d.win.style.top = p.y + (d.H > 1000 ? 760 : 0) + 'px'; // below the player on a tall desk
}

/* A phone (landscape or portrait) with a desktop on its screen. */
export function makePhone(parent, w, h) {
  const ph = el('phone', parent, { width: w + 'px', height: h + 'px' });
  const screen = el('screen', ph);
  const sw = w - 40,
    sh = h - 40;
  const W = Math.max(1600, Math.round((sw / sh) * 1000)); // fill a wide screen
  const s = Math.min(sw / W, sh / 1000);
  const holder = el('abs', screen, {
    left: (sw - W * s) / 2 + 'px',
    top: (sh - 1000 * s) / 2 + 'px',
    width: W * s + 'px',
    height: 1000 * s + 'px',
    overflow: 'hidden',
  });
  const desk = makeDesk(holder, W);
  desk.root.style.transform = `scale(${s})`;
  return {
    ph,
    screen,
    holder,
    desk,
    s,
    ox: (sw - W * s) / 2 + 20,
    oy: (sh - 1000 * s) / 2 + 20,
  };
}
export function makeLaptop(parent, w) {
  const h = w * 0.64;
  const box = el('laptop abs', parent, { width: w + 'px', height: h + 40 + 'px' });
  const lid = el('lid', box, { left: 0, top: 0, width: w + 'px', height: h + 'px' });
  const screen = el('screen', lid);
  el('base', box, { left: '-60px', top: h + 'px', width: w + 120 + 'px', height: '26px' });
  return { box, screen, w, h };
}
// Lag model for the traditional client: late, and at a low, uneven frame rate.
export const vncTime = (t) => {
  const step = 0.2 + 0.12 * Math.abs(Math.sin(Math.floor(t * 3)));
  return Math.floor((t - 0.45) / step) * step;
};
export const vidTime = (t) => t - 0.063;

export function stopwatchText(sec) {
  const m = Math.floor(sec / 60),
    s = Math.floor(sec % 60),
    ms = Math.floor((sec * 1000) % 1000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}
export const cursorSvg =
  '<svg width="34" height="44" viewBox="0 0 17 22"><path d="M1 1 L1 17 L5 13 L8 20 L11 19 L8 12 L14 12 Z" fill="#fff" stroke="#000" stroke-width="1.2" stroke-linejoin="round"/></svg>';
export const speakerOn =
  '<svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke="#e8edf7" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h4l5-4v14l-5-4H4z" fill="#e8edf7"/><path class="w1" d="M16 9a4 4 0 0 1 0 6"/><path class="w2" d="M19 6a8 8 0 0 1 0 12"/></svg>';
export const speakerOff =
  '<svg width="54" height="54" viewBox="0 0 24 24" fill="none" stroke="#8693ab" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h4l5-4v14l-5-4H4z" fill="#8693ab"/><path d="M17 9l5 6M22 9l-5 6"/></svg>';
export const monitorSvg = (c) =>
  `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="${c}" stroke-width="1.4" stroke-linejoin="round"><rect x="2.5" y="4" width="19" height="12.5" rx="1.5"/><path d="M8 20.5h8M12 16.5v4"/></svg>`;

// screenshot with a highlighted row
export function shotScene(img, box, text) {
  return {
    build: (root) => {
      const W = 1066,
        H = 900,
        L = 427,
        T = 70,
        s = W / 1800;
      const sh = el('shot', root, {
        width: W + 'px',
        height: H + 'px',
        left: L + 'px',
        top: T + 'px',
        backgroundImage: `url(${A}${img})`,
      });
      const hl = el('hl', root, {
        left: L + box[0] * s - 8 + 'px',
        top: T + box[1] * s - 8 + 'px',
        width: (box[2] - box[0]) * s + 16 + 'px',
        height: (box[3] - box[1]) * s + 16 + 'px',
      });
      const cap = el(
        'abs',
        root,
        { left: 0, right: 0, top: '990px' },
        `<div class="title" style="font-size:48px">${text}</div>`,
      );
      return { sh, hl, cap };
    },
    update: ({ sh, hl, cap }, lt, dur, root) => {
      root.style.opacity = fade(lt, dur);
      hl.style.opacity = ease((lt - 0.8) / 0.5);
      sh.style.transform = `scale(${lerp(1, 1.03, lt / dur)})`;
      cap.style.opacity = ease((lt - 0.5) / 0.5);
    },
  };
}

/* ---------- a film playing on the shared desktop ---------- */
// The consumer cut shows the desktop playing a film full screen: a coast at dusk with
// mountains drifting past at different speeds and a boat crossing, so smooth motion shows.
// Like the desk, it is a pure function of its own clock, so a late screen shows late
// pictures. Drawn at any size; chrome adds the player's progress bar.
const ridge = (x, k, seed) =>
  Math.sin(x * 0.004 * k + seed) * 38 +
  Math.sin(x * 0.011 * k + seed * 2.3) * 16 +
  Math.sin(x * 0.027 * k + seed * 4.1) * 6;
export function drawFilm(g, time, W, H, chrome = true) {
  const u = W / 1600;
  const hz = H * 0.6;
  const sky = g.createLinearGradient(0, 0, 0, hz);
  sky.addColorStop(0, '#1b2350');
  sky.addColorStop(0.55, '#7a3f78');
  sky.addColorStop(0.85, '#e0735a');
  sky.addColorStop(1, '#f6b26b');
  g.fillStyle = sky;
  g.fillRect(0, 0, W, hz + 2);
  // the sun, low over the sea
  const sx = W * 0.64,
    sy = hz - 150 * u;
  const glow = g.createRadialGradient(sx, sy, 0, sx, sy, 420 * u);
  glow.addColorStop(0, 'rgba(255,214,150,0.85)');
  glow.addColorStop(0.15, 'rgba(255,190,120,0.45)');
  glow.addColorStop(1, 'rgba(255,170,110,0)');
  g.fillStyle = glow;
  g.fillRect(0, 0, W, hz);
  g.fillStyle = '#ffe2b0';
  g.beginPath();
  g.arc(sx, sy, 70 * u, 0, 7);
  g.fill();
  // three mountain ranges, nearer ones moving faster
  for (const [k, speed, lift, col, seed] of [
    [0.6, 12, 150, '#5b3a72', 1.1],
    [1, 34, 90, '#3a2a5e', 2.7],
    [1.6, 90, 30, '#1e1a3e', 4.2],
  ]) {
    const off = time * speed;
    g.fillStyle = col;
    g.beginPath();
    g.moveTo(0, hz + 2);
    for (let x = 0; x <= W + 8 * u; x += 8 * u)
      g.lineTo(x, hz - lift * u - ridge(x / u + off, k, seed) * u);
    g.lineTo(W, hz + 2);
    g.fill();
  }
  // the sea, with the sun's path shimmering on it
  const sea = g.createLinearGradient(0, hz, 0, H);
  sea.addColorStop(0, '#2a2552');
  sea.addColorStop(1, '#0c1030');
  g.fillStyle = sea;
  g.fillRect(0, hz, W, H - hz);
  for (let i = 0; i < 26; i++) {
    const d = i / 25;
    const y = hz + (H - hz) * d * d + 6 * u;
    const w = (60 + 340 * d) * u * (0.6 + 0.4 * Math.sin(time * 2.1 + i * 1.7));
    const x = sx + Math.sin(time * 0.9 + i * 2.3) * 30 * d * u;
    g.fillStyle = `rgba(255,205,150,${0.5 * (1 - d) + 0.08})`;
    g.fillRect(x - w / 2, y, w, (2 + 4 * d) * u);
  }
  // a sailing boat crossing the sun's path
  const bx = ((time * 46 + 300) % 2000) * u - 200 * u,
    by = hz + 46 * u;
  g.fillStyle = '#120f26';
  g.beginPath();
  g.moveTo(bx - 46 * u, by);
  g.lineTo(bx + 46 * u, by);
  g.lineTo(bx + 30 * u, by + 14 * u);
  g.lineTo(bx - 32 * u, by + 14 * u);
  g.fill();
  g.beginPath();
  g.moveTo(bx - 2 * u, by - 4 * u);
  g.lineTo(bx - 2 * u, by - 96 * u);
  g.lineTo(bx + 40 * u, by - 6 * u);
  g.fill();
  g.beginPath();
  g.moveTo(bx - 8 * u, by - 82 * u);
  g.lineTo(bx - 8 * u, by - 8 * u);
  g.lineTo(bx - 40 * u, by - 8 * u);
  g.fill();
  if (!chrome) return;
  // the player's controls along the bottom
  const fade = g.createLinearGradient(0, H - 130 * u, 0, H);
  fade.addColorStop(0, 'rgba(0,0,0,0)');
  fade.addColorStop(1, 'rgba(0,0,0,0.6)');
  g.fillStyle = fade;
  g.fillRect(0, H - 130 * u, W, 130 * u);
  const total = 6500,
    pos = 2361 + time;
  const bx0 = 60 * u,
    bw = W - 120 * u,
    by0 = H - 52 * u;
  g.fillStyle = 'rgba(255,255,255,0.25)';
  g.fillRect(bx0, by0, bw, 6 * u);
  g.fillStyle = '#fff';
  g.fillRect(bx0, by0, (bw * pos) / total, 6 * u);
  g.font = `${22 * u}px "JetBrains Mono"`;
  g.textBaseline = 'alphabetic';
  g.fillText(hms(pos), bx0, by0 - 16 * u);
  g.textAlign = 'right';
  g.fillText(hms(total), bx0 + bw, by0 - 16 * u);
  g.textAlign = 'left';
}
const hms = (s) =>
  `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s) % 60).padStart(2, '0')}`;
// A screen that plays the film: a canvas of the given size in pixels.
export function makeFilm(parent, w, h, css = {}) {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  Object.assign(cv.style, { position: 'absolute', left: 0, top: 0, ...css });
  parent.appendChild(cv);
  return { cv, g: cv.getContext('2d'), w, h };
}
export const setFilm = (f, time, chrome = true) => drawFilm(f.g, time, f.w, f.h, chrome);
// A flat-screen TV on a two-legged stand, w pixels wide, with a 16:9 screen playing the film.
export function makeTV(parent, w) {
  const h = Math.round((w * 9) / 16);
  const box = el('abs', parent, { width: w + 'px', height: h + 34 + 'px' });
  const panel = el('abs', box, {
    left: 0,
    top: 0,
    width: w + 'px',
    height: h + 'px',
    background: '#05070c',
    borderRadius: '10px',
    boxShadow: '0 0 0 3px #2a3550, 0 40px 120px rgba(0,0,0,0.6)',
  });
  const screen = el('abs', panel, { inset: '10px', overflow: 'hidden', borderRadius: '3px' });
  const film = makeFilm(screen, w - 20, h - 20);
  for (const x of [0.18, 0.82])
    el('abs', box, {
      left: w * x - 30 + 'px',
      top: h + 'px',
      width: '60px',
      height: '30px',
      borderBottom: '5px solid #3a4560',
      borderLeft: x < 0.5 ? '5px solid #3a4560' : 0,
      borderRight: x > 0.5 ? '5px solid #3a4560' : 0,
      boxSizing: 'border-box',
      transform: `skewX(${x < 0.5 ? 20 : -20}deg)`,
    });
  return { box, panel, screen, film, w, h };
}
// A phone or tablet (landscape) playing the film full screen.
export function makeFilmPhone(parent, w, h, radius) {
  const ph = el('phone', parent, { width: w + 'px', height: h + 'px' });
  if (radius) ph.style.borderRadius = radius + 'px';
  const screen = el('screen', ph);
  if (radius) screen.style.borderRadius = radius - 18 + 'px';
  const film = makeFilm(screen, w - 40, h - 40);
  return { ph, screen, film };
}
