import { ease, el, fade, lerp } from '../engine/kit.mjs';

// Scene: safety in one beat, for the consumer cut: on your network, encrypted, and approved
// device by device. Each card comes in as the voiceover names it. The developer cut tells the
// full story instead (trust, security, network).

const icon = (d) =>
  `<svg viewBox="0 0 24 24" width="96" height="96" fill="none" stroke="#8db8ff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
const CARDS = [
  [
    '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z"/>',
    'Stays on your network',
    'Remote access only if you turn it on',
    0.4,
  ],
  [
    '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    'Encrypted',
    'Picture, sound and sign-in',
    1.9,
  ],
  [
    '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
    'Approved by you',
    'New devices wait for your OK',
    3.4,
  ],
];

export const build = (root) => {
  const cards = CARDS.map(([d, title, sub, at], i) => ({
    at,
    e: el(
      'abs',
      root,
      {
        left: 170 + i * 540 + 'px',
        top: '340px',
        width: '500px',
        height: '360px',
        boxSizing: 'border-box',
        padding: '56px 36px',
        borderRadius: '28px',
        background: 'rgba(16,22,40,0.85)',
        boxShadow: '0 0 0 2px #1c2740, 0 30px 90px rgba(0,0,0,0.45)',
        textAlign: 'center',
      },
      `${icon(d)}<div style="font-size:40px;font-weight:600;margin-top:28px">${title}</div>` +
        `<div style="font-size:24px;color:#a9b5ca;margin-top:14px;line-height:1.35">${sub}</div>`,
    ),
  }));
  return { cards };
};

export const update = ({ cards }, lt, dur, root) => {
  root.style.opacity = fade(lt, dur);
  for (const c of cards) {
    const k = ease((lt - c.at) / 0.6);
    c.e.style.opacity = k;
    c.e.style.transform = `translateY(${lerp(40, 0, k)}px)`;
  }
};
