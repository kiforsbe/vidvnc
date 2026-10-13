import { ease, el, fade, lerp, makeFilmPhone, makeTV, setFilm } from '../engine/kit.mjs';

// Scene: the hook. A living room: the film plays on the TV and on a phone in the foreground,
// both from the computer in the other room.

export const build = (root) => {
  // the room: a lamp's warm light, a floor and a low sideboard under the TV
  el('abs', root, {
    left: '420px',
    top: '120px',
    width: '560px',
    height: '560px',
    background: 'radial-gradient(circle, rgba(246,178,107,0.22), rgba(246,178,107,0) 70%)',
  });
  el('abs', root, {
    left: '688px',
    top: '330px',
    width: '6px',
    height: '600px',
    background: '#2a3550',
  });
  el('abs', root, {
    left: '626px',
    top: '300px',
    width: '130px',
    height: '70px',
    background: 'linear-gradient(#f3c48a, #c98a52)',
    clipPath: 'polygon(22% 0, 78% 0, 100% 100%, 0 100%)',
    opacity: 0.85,
  });
  el('abs', root, {
    left: 0,
    top: '930px',
    width: '1920px',
    height: '150px',
    background: 'linear-gradient(rgba(20,26,48,0.85), rgba(10,15,28,0.95))',
  });
  el('abs', root, {
    left: '820px',
    top: '860px',
    width: '1000px',
    height: '70px',
    borderRadius: '10px',
    background: 'linear-gradient(#232c4a, #141a30)',
    boxShadow: '0 0 0 2px #2a3550',
  });
  const tv = makeTV(root, 980);
  tv.box.style.left = '830px';
  tv.box.style.top = '275px';
  const ph = makeFilmPhone(root, 760, 380);
  ph.ph.style.left = '90px';
  ph.ph.style.top = '610px';
  return { tv, ph };
};

export const update = ({ tv, ph }, lt, dur, root, { start }) => {
  root.style.opacity = fade(lt, dur, 0.6, 0.4);
  const time = start + lt;
  setFilm(tv.film, time);
  setFilm(ph.film, time - 0.063, false);
  tv.box.style.transform = `scale(${lerp(0.97, 1, ease(lt / dur))})`;
  const up = ease((lt - 0.8) / 1);
  ph.ph.style.opacity = up;
  ph.ph.style.transform = `translateY(${lerp(260, 0, up)}px) rotate(-7deg)`;
};
