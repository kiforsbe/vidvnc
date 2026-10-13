import { A, ease, el, fade, lerp } from '../engine/kit.mjs';

// Scene: how it is built, from untrusted to trusted.

const ZONES = [
  { x: 40, w: 380, name: 'Untrusted', col: '255,107,107' },
  { x: 440, w: 470, name: 'Guarded edge', col: '255,169,77' },
  { x: 930, w: 450, name: 'Sandboxed', col: '252,196,25' },
  { x: 1400, w: 480, name: 'Trusted', col: '77,171,247' },
];
const CARDS = {
  dev: {
    x: 80,
    y: 360,
    w: 300,
    h: 300,
    t: 'Any device',
    s: ['A browser on your', 'phone, tablet or PC'],
  },
  relay: {
    x: 480,
    y: 250,
    w: 340,
    h: 170,
    t: 'Media relay',
    s: ['One UDP port. Lets in', 'only proven senders'],
  },
  server: {
    x: 480,
    y: 640,
    w: 340,
    h: 170,
    t: 'Server',
    s: ['Encrypted sign-in.', 'Never handles your screen'],
  },
  net: {
    x: 990,
    y: 250,
    w: 350,
    h: 170,
    t: 'Video connection',
    s: ["Sandboxed. Can't see your", 'screen, input or files'],
  },
  worker: {
    x: 1460,
    y: 250,
    w: 380,
    h: 170,
    t: 'Screen capture',
    s: ['No network access.', 'Checks every input'],
  },
  app: {
    x: 1540,
    y: 640,
    w: 300,
    h: 170,
    t: 'VidVNC app',
    s: ['You approve devices', 'and who may control'],
  },
};
const mid = (c, side) => {
  const k = CARDS[c];
  return side === 'l'
    ? [k.x, k.y + k.h / 2]
    : side === 'r'
      ? [k.x + k.w, k.y + k.h / 2]
      : side === 't'
        ? [k.x + k.w / 2, k.y]
        : [k.x + k.w / 2, k.y + k.h];
};
const PIPES = [
  { id: 'p1', a: ['dev', 'r'], b: ['relay', 'l'], label: 'UDP', bend: true },
  { id: 'p2', a: ['relay', 'r'], b: ['net', 'l'], label: 'loopback' },
  { id: 'p3', a: ['net', 'r'], b: ['worker', 'l'], label: 'pipe' },
  { id: 'p4', a: ['dev', 'r'], b: ['server', 'l'], label: 'HTTPS', bend: true },
  { id: 'p5', a: ['server', 'r'], b: ['worker', 'b'], label: 'pipe', elbow: true },
  { id: 'p6', a: ['app', 'l'], b: ['server', 'r'], label: 'owner pipe', offset: 40 },
];
function pipePath(p) {
  const [x1, y1] = mid(...p.a),
    [x2, y2] = mid(...p.b);
  if (p.elbow) return `M${x1} ${y1 - 40} H${1460} Q${1500} ${y1 - 40} ${1500} ${y1 - 80} V${y2}`;
  if (p.offset) return `M${x1} ${y1 + p.offset} H${x2}`;
  if (p.bend) {
    const mx = (x1 + x2) / 2;
    return `M${x1} ${y1} C${mx} ${y1} ${mx} ${y2} ${x2} ${y2}`;
  }
  return `M${x1} ${y1} H${x2}`;
}
export const build = (root) => {
  const z = ZONES.map((zn, i) =>
    el(
      'abs',
      root,
      {
        left: zn.x + 'px',
        top: '120px',
        width: zn.w + 'px',
        height: '800px',
        borderRadius: '28px',
        background: `rgba(${zn.col},0.05)`,
        border: `2px ${i === 2 ? 'dashed' : 'solid'} rgba(${zn.col},0.35)`,
        boxSizing: 'border-box',
      },
      `<div style="position:absolute;left:0;right:0;top:22px;text-align:center;font-size:30px;font-weight:600;color:rgb(${zn.col})">${zn.name}</div>`,
    ),
  );
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', 1920);
  svg.setAttribute('height', 1080);
  svg.style.position = 'absolute';
  svg.style.left = 0;
  svg.style.top = 0;
  root.appendChild(svg);
  const pipes = PIPES.map((p) => {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', pipePath(p));
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', '#3f5f9f');
    path.setAttribute('stroke-width', 6);
    path.setAttribute('stroke-linecap', 'round');
    svg.appendChild(path);
    const len = path.getTotalLength();
    path.style.strokeDasharray = len;
    path.style.strokeDashoffset = len;
    const lb = el(
      'abs mono',
      root,
      {
        fontSize: '22px',
        color: '#a9b5ca',
        transform: p.bend ? 'translate(-50%, -50%)' : 'translate(-50%, -100%)',
        whiteSpace: 'nowrap',
        zIndex: 5,
        background: '#0d1426',
        padding: '2px 10px',
        borderRadius: '8px',
      },
      p.label,
    );
    const m = path.getPointAtLength(p.elbow ? len * 0.4 : len / 2);
    lb.style.left = m.x + 'px';
    lb.style.top = m.y + (p.bend ? 0 : -12) + 'px';
    return { ...p, path, len, lb };
  });
  const cards = Object.fromEntries(
    Object.entries(CARDS).map(([k, c]) => [
      k,
      el(
        'abs',
        root,
        {
          left: c.x + 'px',
          top: c.y + 'px',
          width: c.w + 'px',
          height: c.h + 'px',
          borderRadius: '20px',
          background: '#111a2e',
          border: '2px solid #2a3a5c',
          boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
          boxSizing: 'border-box',
          padding: k === 'dev' ? '170px 20px 0' : '26px 24px 0',
        },
        (k === 'dev'
          ? '<div style="position:absolute;left:105px;top:30px;width:90px;height:130px;border:5px solid #a9b5ca;border-radius:18px;box-sizing:border-box"></div>'
          : '') +
          `<div style="font-size:34px;font-weight:600;${k === 'dev' ? 'text-align:center' : ''}">${c.t}</div><div style="margin-top:10px;font-size:23px;line-height:1.35;white-space:nowrap;color:#a9b5ca;${k === 'dev' ? 'text-align:center' : ''}">${c.s.join('<br>')}</div>`,
      ),
    ]),
  );
  const dots = [...Array(18)].map(() => {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('r', 9);
    svg.appendChild(c);
    return c;
  });
  const stamp = el(
    'abs',
    root,
    {
      left: '930px',
      top: '450px',
      width: '450px',
      textAlign: 'center',
      fontSize: '26px',
      fontWeight: 600,
      color: 'rgb(252,196,25)',
    },
    'A break-in stays in here',
  );
  const arrow = el('abs', root, {
    left: '40px',
    width: '1840px',
    top: '950px',
    height: '6px',
    borderRadius: '3px',
    background:
      'linear-gradient(90deg, rgb(255,107,107), rgb(255,169,77), rgb(252,196,25), rgb(77,171,247))',
  });
  const arrowL = el(
    'abs',
    root,
    {
      left: 0,
      right: 0,
      top: '975px',
      textAlign: 'center',
      fontSize: '26px',
      color: '#a9b5ca',
    },
    'From untrusted to trusted, only through narrow, checked pipes',
  );
  return { z, pipes, cards, dots, stamp, arrow, arrowL };
};

export const update = (st, lt, dur, root, { marks: [edge, sandbox, trusted] }) => {
  root.style.opacity = fade(lt, dur, 0.5, 0.5);
  st.z.forEach((e, i) => (e.style.opacity = ease((lt - i * 0.25) / 0.6)));
  const order = ['dev', 'relay', 'server', 'net', 'worker', 'app'];
  order.forEach((k, i) => {
    const e = st.cards[k],
      q = ease((lt - 0.5 - i * 0.25) / 0.6);
    e.style.opacity = q;
    e.style.transform = `translateY(${lerp(20, 0, q)}px)`;
  });
  st.pipes.forEach((p, i) => {
    const q = ease((lt - 2.2 - i * 0.2) / 0.9);
    p.path.style.strokeDashoffset = p.len * (1 - q);
    p.lb.style.opacity = q;
  });
  // the spotlight follows the voiceover: the edge, then the sandbox, then the pipes into the trusted side
  const focus =
    lt < edge
      ? null
      : lt < sandbox
        ? ['relay']
        : lt < trusted
          ? ['net']
          : ['worker', 'app', 'server'];
  for (const k of order) {
    const on = focus && focus.includes(k);
    st.cards[k].style.borderColor = on ? '#2f6feb' : '#2a3a5c';
    st.cards[k].style.boxShadow = on
      ? '0 0 0 2px #2f6feb, 0 0 50px rgba(47,111,235,0.55)'
      : '0 20px 60px rgba(0,0,0,0.4)';
    st.cards[k].style.filter = focus && !on ? 'brightness(0.55)' : 'none';
  }
  const pipeOn =
    lt >= trusted
      ? ['p3', 'p5', 'p6']
      : lt >= sandbox
        ? ['p2', 'p3']
        : lt >= edge
          ? ['p1', 'p2']
          : null;
  st.pipes.forEach((p) => {
    const on = pipeOn && pipeOn.includes(p.id);
    p.path.setAttribute('stroke', on ? '#8db8ff' : '#3f5f9f');
    p.path.setAttribute('stroke-width', on ? 8 : 6);
  });
  st.stamp.style.opacity =
    lt > sandbox + 1.3 && lt < trusted ? ease((lt - sandbox - 1.3) / 0.5) : 0;
  st.arrow.style.opacity = st.arrowL.style.opacity = ease((lt - 4) / 0.8);
  // packets: media flows device -> relay -> sandbox -> capture; strangers are turned away at the relay
  const route = [st.pipes[0], st.pipes[1], st.pipes[2]];
  st.dots.forEach((d, i) => {
    const bad = i % 3 === 0;
    const u = ((lt - 4.2) * 0.12 + i / st.dots.length) % 1;
    if (lt < 4.2) {
      d.setAttribute('opacity', 0);
      return;
    }
    const seg = Math.floor(u * 3),
      f = u * 3 - seg;
    if (bad && seg >= 1) {
      // refused at the relay: knocked back and fading out
      const back = (seg - 1 + f) / 2;
      const pt = route[0].path.getPointAtLength(route[0].len * (1 - back * 0.4));
      d.setAttribute('cx', pt.x);
      d.setAttribute('cy', pt.y);
      d.setAttribute('opacity', Math.max(0, 1 - back * 3));
      d.setAttribute('fill', '#ff6b6b');
      return;
    }
    const p = route[seg];
    const pt = p.path.getPointAtLength(p.len * f);
    d.setAttribute('cx', pt.x);
    d.setAttribute('cy', pt.y);
    d.setAttribute('opacity', 1);
    d.setAttribute('fill', bad ? '#ff6b6b' : '#8db8ff');
  });
};
