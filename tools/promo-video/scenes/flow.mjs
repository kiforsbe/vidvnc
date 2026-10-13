import { clamp, ease, el, fade, makeLaptop, vidTime } from '../engine/kit.mjs';

// Scene: stay in your flow. A remote workstation through VidVNC: code being typed, the file
// scrolling smoothly, every keystroke on screen at once. An illustration, like the race.

const C = {
  kw: '#c792ea',
  fn: '#82aaff',
  str: '#c3e88d',
  com: '#637087',
  tx: '#d6deeb',
  num: '#f78c6c',
};
const CODE = [
  [['com', '// Resize every frame to the stream size before it is encoded.']],
  [
    ['kw', 'export function '],
    ['fn', 'fitFrame'],
    ['tx', '(frame, target) {'],
  ],
  [
    ['kw', '  const '],
    ['tx', 'scale = Math.'],
    ['fn', 'min'],
    ['tx', '(target.w / frame.w, target.h / frame.h);'],
  ],
  [
    ['kw', '  const '],
    ['tx', 'w = Math.'],
    ['fn', 'round'],
    ['tx', '(frame.w * scale);'],
  ],
  [
    ['kw', '  const '],
    ['tx', 'h = Math.'],
    ['fn', 'round'],
    ['tx', '(frame.h * scale);'],
  ],
  [
    ['kw', '  return '],
    ['tx', '{ w, h, x: (target.w - w) / '],
    ['num', '2'],
    ['tx', ', y: (target.h - h) / '],
    ['num', '2'],
    ['tx', ' };'],
  ],
  [['tx', '}']],
  [['tx', '']],
  [['com', '// Pick the profile for this display.']],
  [
    ['kw', 'export function '],
    ['fn', 'pickProfile'],
    ['tx', '(display, profiles) {'],
  ],
  [
    ['kw', '  return '],
    ['tx', 'profiles.'],
    ['fn', 'find'],
    ['tx', '((p) => p.height <= display.height)'],
  ],
  [
    ['tx', '    ?? profiles['],
    ['num', '0'],
    ['tx', '];'],
  ],
  [['tx', '}']],
  [['tx', '']],
  [
    ['kw', 'export const '],
    ['tx', 'DEFAULTS = {'],
  ],
  [
    ['tx', '  fps: '],
    ['num', '60'],
    ['tx', ','],
  ],
  [
    ['tx', '  codec: '],
    ['str', "'h264'"],
    ['tx', ','],
  ],
  [
    ['tx', '  audio: '],
    ['str', "'opus'"],
    ['tx', ','],
  ],
  [['tx', '};']],
  [['tx', '']],
  [
    ['kw', 'export function '],
    ['fn', 'frameBudget'],
    ['tx', '(fps) {'],
  ],
];
const TYPED = [
  ['kw', '  return '],
  ['num', '1000'],
  ['tx', ' / fps; '],
  ['com', '// milliseconds a frame'],
];

function draw(g, time, W, H) {
  g.fillStyle = '#0d1220';
  g.fillRect(0, 0, W, H);
  // title bar and tabs
  g.fillStyle = '#121a2c';
  g.fillRect(0, 0, W, 44);
  g.fillStyle = '#1a2338';
  g.fillRect(16, 8, 190, 36);
  g.font = '500 17px "Instrument Sans"';
  g.textBaseline = 'middle';
  g.fillStyle = '#d6deeb';
  g.fillText('stream.js', 36, 27);
  g.fillStyle = '#637087';
  g.fillText('profiles.js', 236, 27);
  // the file scrolls smoothly, then a new line is typed
  const lh = 30,
    top = 64;
  const scroll = lh * 5 * ease(clamp((time - 0.6) / 1.6));
  const typed = Math.floor(clamp((time - 2.6) * 16, 0, 999));
  const lines = [...CODE, TYPED, [['tx', '}']]];
  g.save();
  g.beginPath();
  g.rect(0, 50, W, H - 50);
  g.clip();
  g.font = '19px "JetBrains Mono"';
  lines.forEach((toks, i) => {
    const y = top + i * lh - scroll + lh / 2;
    if (y < 30 || y > H + lh) return;
    g.fillStyle = '#3d4860';
    g.textAlign = 'right';
    g.fillText(String(i + 1), 56, y);
    g.textAlign = 'left';
    let x = 80,
      left = i === CODE.length ? typed : Infinity;
    if (i === CODE.length) {
      g.fillStyle = 'rgba(130,170,255,0.08)';
      g.fillRect(0, y - lh / 2, W, lh);
    }
    for (const [c, t] of toks) {
      const part = t.slice(0, Math.max(0, left));
      left -= t.length;
      g.fillStyle = C[c];
      g.fillText(part, x, y);
      x += g.measureText(part).width;
    }
    if (i === CODE.length && Math.floor(time * 2.5) % 2 === 0) {
      g.fillStyle = '#82aaff';
      g.fillRect(x + 1, y - 12, 2, 24);
    }
  });
  g.restore();
}

export const build = (root) => {
  const lap = makeLaptop(root, 1100);
  lap.box.style.left = '410px';
  lap.box.style.top = '150px';
  const cv = document.createElement('canvas');
  cv.width = 1056;
  cv.height = 660;
  cv.style.position = 'absolute';
  lap.screen.appendChild(cv);
  const label = el(
    'label',
    root,
    { left: 0, width: '1920px', top: '80px', color: '#8db8ff' },
    'Your workstation, through VidVNC',
  );
  const t = el(
    'abs',
    root,
    { left: 0, right: 0, top: '930px' },
    '<div class="title" style="font-size:56px">Type and scroll at full speed.</div>',
  );
  el('note', root, {}, 'Illustration');
  return { g: cv.getContext('2d'), label, t };
};

export const update = ({ g, label, t }, lt, dur, root) => {
  root.style.opacity = fade(lt, dur);
  draw(g, vidTime(lt), 1056, 660);
  label.style.opacity = ease((lt - 0.3) / 0.5);
  t.style.opacity = ease((lt - 1) / 0.5);
};
