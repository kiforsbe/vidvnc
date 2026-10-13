import { clamp, ease, el, eqAt, fade, lerp, makeTV, setFilm, speakerOn } from '../engine/kit.mjs';

// Scene: watch. The film plays on the big screen with its sound; the desktop's song is its
// soundtrack here (music.py), so the speaker moves with what you hear.

export const build = (root) => {
  const tv = makeTV(root, 1300);
  tv.box.style.left = '310px';
  tv.box.style.top = '70px';
  const sp = el('abs', root, { left: '600px', top: '900px' }, speakerOn);
  const t = el(
    'abs',
    root,
    { left: '680px', right: '400px', top: '892px', textAlign: 'left' },
    '<div class="title" style="font-size:56px;text-align:left">Smooth video, with the sound.</div>',
  );
  return { tv, sp, t };
};

export const update = ({ tv, sp, t }, lt, dur, root, { start }) => {
  root.style.opacity = fade(lt, dur, 0.5, 0.4);
  const time = start + lt;
  setFilm(tv.film, time);
  tv.box.style.transform = `scale(${lerp(0.94, 1, ease(lt / 2))})`;
  const k = ease((lt - 0.8) / 0.5);
  sp.style.opacity = k;
  t.style.opacity = k;
  const waves = sp.querySelectorAll('path');
  const level = eqAt(time)[48];
  waves[1].style.opacity = 0.3 + 0.7 * level;
  waves[2].style.opacity = clamp(1.4 * level - 0.3, 0.15, 1);
};
