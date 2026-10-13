import { A, el, fade } from '../engine/kit.mjs';

// Scene: end card. opts.audience picks the words: the consumer cut promises every screen at
// home and the first release; the developer cut says it can be built from source today. Both
// say what it runs on (the README's requirements table), so nobody feels misled later.

const WORDS = {
  consumer: {
    tag: 'Your desktop, in real time, on every screen at home.',
    line: 'Mac and Windows · First release coming soon',
  },
  developer: {
    tag: 'Your desktop, in real time, on your network.',
    line: 'Development preview · Build it from source today · First release coming soon',
  },
};

export const build = (root, { opts }) => {
  const w = WORDS[opts.audience];
  el('abs', root, {
    left: '880px',
    top: '210px',
    width: '160px',
    height: '160px',
    background: `url(${A}icon.png) center/contain no-repeat`,
  });
  el(
    'abs',
    root,
    { left: 0, right: 0, top: '410px' },
    `<div class="title" style="font-size:96px">VidVNC</div><div class="sub" style="margin-top:10px;font-size:36px;color:#e8edf7">${w.tag}</div>`,
  );
  el(
    'abs',
    root,
    { left: 0, right: 0, top: '660px' },
    `<div class="sub mono" style="font-size:34px;color:#8db8ff">kiforsbe.github.io/vidvnc</div><div class="sub" style="margin-top:18px;font-size:28px">${w.line}</div>` +
      '<div class="sub" style="margin-top:40px;font-size:22px;color:#8693ab">Windows 11 25H2 with a hardware video encoder, or macOS 27 on Apple Silicon</div>',
  );
  return {};
};

export const update = (_, lt, dur, root) => {
  root.style.opacity = fade(lt, dur, 0.6, 0.8);
};
