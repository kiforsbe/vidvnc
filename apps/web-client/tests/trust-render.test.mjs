import test from 'node:test';
import assert from 'node:assert/strict';

// Runs the real trust.js against a very small fake DOM, to pin what the page does when
// something goes wrong: the person must never be left on "Checking this host's certificate…".
// Nothing here touches a network or a browser; `fetch`, `document`, `location` and
// `navigator` are stand-ins installed for one test and put back afterwards.
const FP =
  '47:20:AA:7A:75:EA:ED:68:C7:C2:53:50:B1:C1:D8:C9:F5:DC:31:EB:CD:9F:BE:FF:F0:55:CC:8D:3D:E3:00:D7';
const REQUIRED = {
  active: true,
  enrolmentStatus: 'required',
  strategy: 'mkcert',
  fingerprint: FP,
  httpsPort: 4383,
  download: '/api/trust/anchor',
};

function makeDom() {
  const control = { failOn: null };
  const node = (tag) => {
    if (control.failOn === tag) throw new Error(`cannot build <${tag}>`);
    const n = { tag, children: [], attrs: {}, listeners: {}, className: '', id: '', value: '' };
    n.append = (...children) => n.children.push(...children);
    n.replaceChildren = (...children) => {
      n.children = children;
    };
    n.setAttribute = (name, value) => {
      n.attrs[name] = value;
    };
    n.addEventListener = (type, listener) => {
      n.listeners[type] = listener;
    };
    Object.defineProperty(n, 'textContent', {
      get: () => n.children.map((child) => child.textContent).join(''),
    });
    return n;
  };
  const root = node('div');
  const document = {
    getElementById: (id) => (id === 'trust-root' ? root : null),
    createElement: node,
    createTextNode: (text) => ({ textContent: text }),
  };
  return { root, document, control };
}

const find = (node, predicate) => {
  if (predicate(node)) return node;
  for (const child of node.children ?? []) {
    const hit = find(child, predicate);
    if (hit) return hit;
  }
  return null;
};

let runs = 0;
async function run(
  t,
  {
    fetchImpl,
    failOn = null,
    userAgent = 'Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0',
  },
) {
  const dom = makeDom();
  dom.control.failOn = failOn;
  const saved = {};
  for (const name of ['document', 'location', 'navigator', 'fetch'])
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
  const install = (name, value) =>
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  install('document', dom.document);
  install('location', { hostname: '192.168.1.20' });
  install('navigator', { userAgent, maxTouchPoints: 0 });
  install('fetch', fetchImpl);
  t.after(() => {
    for (const [name, descriptor] of Object.entries(saved))
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
  });
  // A query string gives every run its own copy of trust.js; it executes on import.
  await import(new URL(`../src/trust.js?run=${++runs}`, import.meta.url).href);
  return dom;
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));
const respond = (status, body) => async () => ({ status, json: async () => body });

test('a working status renders the fingerprint, the steps for the device and the removal steps', async (t) => {
  const { root } = await run(t, { fetchImpl: respond(200, REQUIRED) });
  await settle();
  assert.equal(find(root, (n) => n.className === 'fingerprint').textContent, FP);
  assert.match(root.textContent, /Install on Linux/);
  assert.match(root.textContent, /Remove it later on Linux/);
  assert.match(root.textContent, /issued by mkcert/);
  assert.match(root.textContent, /certificate authority/i);
  assert.doesNotMatch(root.textContent, /Checking this host/);
});

test('an unreachable host becomes the error view with a retry, not an endless spinner', async (t) => {
  const { root } = await run(t, {
    fetchImpl: async () => {
      throw new TypeError('network down');
    },
  });
  await settle();
  assert.match(root.textContent, /Could not load the certificate details/);
  assert.ok(find(root, (n) => n.tag === 'button'));
  assert.doesNotMatch(root.textContent, /Checking this host/);
});

test('if building the page throws, the person gets the error view and can retry', async (t) => {
  // <select> is built part-way through the install section, after the page was decided.
  const dom = await run(t, { fetchImpl: respond(200, REQUIRED), failOn: 'select' });
  await settle();
  assert.match(dom.root.textContent, /Could not load the certificate details/);
  assert.doesNotMatch(dom.root.textContent, /Checking this host/);
  assert.equal(
    find(dom.root, (n) => n.className === 'download-link'),
    null,
    'no half-built page',
  );
  const retry = find(dom.root, (n) => n.tag === 'button');
  assert.ok(retry, 'there is a retry button');
  // Retry runs the whole thing again; with the fault gone the real page appears.
  dom.control.failOn = null;
  retry.listeners.click();
  await settle();
  assert.equal(find(dom.root, (n) => n.className === 'fingerprint').textContent, FP);
});

test('if even the error view cannot be built, a plain sentence is shown rather than nothing', async (t) => {
  const dom = await run(t, { fetchImpl: respond(200, REQUIRED), failOn: 'h1' });
  await settle();
  assert.match(dom.root.textContent, /could not be shown/i);
  assert.doesNotMatch(dom.root.textContent, /Checking this host/);
});
