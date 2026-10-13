import { ease, el, fade, lerp, makeFilmPhone, makeTV, setFilm } from '../engine/kit.mjs';

// Scene: the screens it plays on: a phone, a tablet and a compatible smart TV (any TV whose
// browser runs the viewer), all showing the same film from a Mac or a Windows PC.

export const build = (root) => {
  const tv = makeTV(root, 900);
  tv.box.style.left = '510px';
  tv.box.style.top = '150px';
  const tab = makeFilmPhone(root, 600, 420, 40);
  tab.ph.style.left = '110px';
  tab.ph.style.top = '420px';
  const ph = makeFilmPhone(root, 540, 270);
  ph.ph.style.left = '1290px';
  ph.ph.style.top = '560px';
  const t = el(
    'abs',
    root,
    { left: 0, right: 0, top: '880px' },
    '<div class="title" style="font-size:56px">Phones, tablets and compatible smart TVs.</div><div class="sub" style="margin-top:12px">From a Mac or a Windows PC.</div>',
  );
  return { tv, tab, ph, t };
};

export const update = ({ tv, tab, ph, t }, lt, dur, root, { start }) => {
  root.style.opacity = fade(lt, dur);
  const time = start + lt;
  setFilm(tv.film, time);
  setFilm(tab.film, time - 0.06, false);
  setFilm(ph.film, time - 0.07, false);
  [
    [ph.ph, 0.2],
    [tab.ph, 0.7],
    [tv.box, 1.2],
  ].forEach(([e, at]) => {
    const k = ease((lt - at) / 0.6);
    e.style.opacity = k;
    e.style.transform = `translateY(${lerp(40, 0, k)}px)`;
  });
  t.style.opacity = ease((lt - 1.4) / 0.5);
};
