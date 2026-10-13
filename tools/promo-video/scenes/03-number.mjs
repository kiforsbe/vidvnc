import { ease, el, fade, lerp, makeLaptop, stopwatchText } from '../engine/kit.mjs';

// Scene 03: the number.

export const build = (root) => {
  const lap = makeLaptop(root, 900);
  lap.box.style.left = '150px';
  lap.box.style.top = '190px';
  const sw1 = el('abs mono', lap.screen, {
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '110px',
    color: '#fff',
    background: '#0d1322',
  });
  const ph = el('phone', root, {
    width: '640px',
    height: '320px',
    left: '1150px',
    top: '330px',
  });
  const scr = el('screen', ph);
  const sw2 = el('abs mono', scr, {
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '74px',
    color: '#fff',
    background: '#0d1322',
  });
  const big = el(
    'abs',
    root,
    { left: 0, right: 0, top: '800px' },
    '<div class="title">About <span class="mono" style="color:#8db8ff">63 ms</span>, screen to screen.</div><div class="sub" style="margin-top:14px">Measured at 1080p, 60 frames a second, on a Mac. Streams up to 4K.</div>',
  );
  const tag1 = el(
    'abs',
    root,
    {
      left: '150px',
      width: '900px',
      top: '140px',
      textAlign: 'center',
      fontSize: '26px',
      color: '#a9b5ca',
    },
    'The Mac',
  );
  const tag2 = el(
    'abs',
    root,
    {
      left: '1150px',
      width: '640px',
      top: '280px',
      textAlign: 'center',
      fontSize: '26px',
      color: '#a9b5ca',
    },
    'The phone, through VidVNC',
  );
  return { sw1, sw2, big, tag1, tag2 };
};

export const update = ({ sw1, sw2, big, tag1, tag2 }, lt, dur, root) => {
  root.style.opacity = fade(lt, dur);
  const run = Math.min(lt, 1.8),
    base = 12.3 + run;
  sw1.textContent = stopwatchText(base);
  sw2.textContent = stopwatchText(base - 0.063);
  big.style.opacity = ease((lt - 1.9) / 0.5);
  big.style.transform = `translateY(${lerp(20, 0, ease((lt - 1.9) / 0.5))}px)`;
};
