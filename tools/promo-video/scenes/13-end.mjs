import { A, el, fade } from '../engine/kit.mjs';

// Scene 13: end card.

export const build = (root) => {
  el('abs', root, {
    left: '880px',
    top: '250px',
    width: '160px',
    height: '160px',
    background: `url(${A}icon.png) center/contain no-repeat`,
  });
  el(
    'abs',
    root,
    { left: 0, right: 0, top: '450px' },
    '<div class="title" style="font-size:96px">VidVNC</div><div class="sub" style="margin-top:10px;font-size:36px;color:#e8edf7">Your desktop, in real time, on your network.</div>',
  );
  el(
    'abs',
    root,
    { left: 0, right: 0, top: '700px' },
    '<div class="sub mono" style="font-size:30px;color:#8db8ff">kiforsbe.github.io/vidvnc</div><div class="sub" style="margin-top:18px;font-size:26px">Mac and Windows · First release coming soon</div>',
  );
  return {};
};

export const update = (_, lt, dur, root) => {
  root.style.opacity = fade(lt, dur, 0.6, 0.8);
};
