import { describeTrust, detectPlatform } from './trust-model.js';
import { PLATFORMS, authorityNote, instructionsFor, reissueNote } from './trust-instructions.js';

// The enrolment page's renderer: fetch the status, let `describeTrust` decide what the page
// may show, and build it. Every piece of text goes in as text, never as markup, because it
// arrives over a connection that may not be encrypted. There is deliberately no scripted
// redirect anywhere: the HTTPS address is a plain link the person chooses to follow.
const root = document.getElementById('trust-root');
const STATUS_URL = '/api/trust/status';
const REQUEST_TIMEOUT_MS = 8000;

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) {
    if (child == null) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

async function fetchStatus() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(STATUS_URL, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      /* Not JSON: the model treats a 200 without a body as a failed lookup. */
    }
    return { httpStatus: response.status, body };
  } catch {
    return { httpStatus: null, body: null };
  } finally {
    clearTimeout(timer);
  }
}

function renderSteps(steps) {
  const list = el('ol', 'steps');
  for (const step of steps) {
    const item = el('li', null, step.text);
    if (step.command) item.append(el('code', 'command', step.command));
    list.append(item);
  }
  return list;
}

function renderInstall(instructions) {
  const card = el('section', 'trust-card');
  card.id = 'install';
  card.append(el('h2', null, `Install on ${instructions.label}`));
  if (instructions.warning) card.append(el('p', 'warning', instructions.warning));
  if (instructions.check) {
    const check = el('div', 'check', el('h3', null, 'Check what you are about to trust'));
    check.append(el('p', 'note', instructions.check.text));
    if (instructions.check.command) check.append(el('code', 'command', instructions.check.command));
    card.append(check);
  }
  for (const phase of instructions.install) {
    const wrapper = el('div', phase.required ? 'phase required' : 'phase');
    if (phase.title) {
      wrapper.append(el('h3', null, phase.title));
    }
    wrapper.append(renderSteps(phase.steps));
    card.append(wrapper);
  }
  if (instructions.notes.length) {
    const notes = el('ul', 'notes');
    for (const note of instructions.notes) notes.append(el('li', null, note));
    card.append(notes);
  }
  return card;
}

function renderUninstall(instructions, strategy) {
  const card = el('section', 'trust-card');
  card.id = 'remove';
  card.append(el('h2', null, `Remove it later on ${instructions.label}`));
  card.append(
    el(
      'p',
      'note',
      'A certificate you installed stays trusted until you remove it. To stop trusting this host, follow these steps.',
    ),
  );
  card.append(renderSteps(instructions.uninstall.steps));
  const reissue = reissueNote(strategy);
  if (reissue) card.append(el('p', 'note', reissue));
  return card;
}

// The chooser sits above both lists and only swaps the platform-specific part, so the
// fingerprint and the download button stay where they are.
function renderInstructions(view, detected) {
  const container = el('div');
  const detail = el('div');
  const select = el('select');
  select.id = 'platform';
  for (const platform of PLATFORMS) {
    const option = el('option', null, platform.label);
    option.value = platform.id;
    select.append(option);
  }
  select.value = detected;
  const show = () => {
    const instructions = instructionsFor(select.value, view.strategy);
    detail.replaceChildren(
      renderInstall(instructions),
      renderUninstall(instructions, view.strategy),
    );
  };
  select.addEventListener('change', show);
  const label = el('label', null, 'Show instructions for');
  label.htmlFor = 'platform';
  container.append(
    el(
      'div',
      'platform-picker',
      label,
      select,
      el('span', 'hint', 'Chosen from your browser. Not your device? Pick another.'),
    ),
    detail,
  );
  show();
  return container;
}

function renderFingerprint(view) {
  const card = el('section', view.compare ? 'trust-card fingerprint-card' : 'trust-card');
  if (view.compare) {
    card.append(el('h2', null, view.compareTitle), el('p', null, view.compare));
  }
  card.append(el('p', 'fingerprint-label', view.fingerprint.label));
  const groups = el('p', 'fingerprint');
  groups.setAttribute('role', 'group');
  groups.setAttribute('aria-label', view.fingerprint.label);
  // No whitespace between groups: the text content is exactly the reported fingerprint.
  for (const group of view.fingerprint.groups)
    groups.append(el('span', 'fingerprint-group', group));
  card.append(groups);
  // What the comparison does and does not cover, kept next to the thing being compared.
  if (view.compareScope) card.append(el('p', 'note', view.compareScope));
  return card;
}

function renderDownload(view) {
  const link = el('a', 'download-link', 'Download the certificate');
  link.href = view.download.href;
  // Said before the download, and only where it is true (see authorityNote).
  const scope = authorityNote(view.strategy);
  return el(
    'section',
    'trust-card',
    el('h2', null, 'Download'),
    scope ? el('p', 'warning', scope) : null,
    link,
    el(
      'p',
      'hint',
      `The file is called ${view.download.filename}. Download it after you have checked the fingerprint above, not before.`,
    ),
  );
}

function renderSecure(view) {
  const link = el('a', null, view.secure.href);
  link.href = view.secure.href;
  link.setAttribute('aria-label', `${view.secure.label}: ${view.secure.href}`);
  return el(
    'section',
    'trust-card',
    el('h2', null, view.secure.label),
    el('p', null, view.secure.intro),
    el('p', null, link),
  );
}

function render(view, platform) {
  const intro = el(
    'section',
    view.state === 'error' ? 'trust-card error-card' : 'trust-card',
    el('p', 'eyebrow', 'VIDVNC / TRUST THIS HOST'),
    el('h1', null, view.title),
    el('p', 'lede', view.message),
  );
  if (view.showInstructions) {
    const removal = el('a', null, 'How to remove it later');
    removal.href = '#remove';
    intro.append(el('p', 'note', 'You can undo this at any time. ', removal, '.'));
  }
  if (view.retry) {
    const retry = el(
      'button',
      'retry-button',
      view.state === 'inactive' ? 'Check again' : 'Try again',
    );
    retry.type = 'button';
    retry.addEventListener('click', load);
    intro.append(retry);
  }
  const parts = [intro];
  if (view.fingerprint) parts.push(renderFingerprint(view));
  if (view.download) parts.push(renderDownload(view));
  if (view.showInstructions) parts.push(renderInstructions(view, platform));
  if (view.secure) parts.push(renderSecure(view));
  root.replaceChildren(...parts);
}

// Whatever goes wrong while building the page, the person is not left on the loading line:
// they get the error view with a retry, and if even that cannot be built, one plain sentence.
function renderFailure() {
  try {
    render(describeTrust(null), 'other');
  } catch {
    const message = document.createElement('p');
    message.append(
      document.createTextNode('This page could not be shown. Reload it to try again.'),
    );
    root.replaceChildren(message);
  }
}

async function load() {
  root.replaceChildren(el('p', 'trust-loading', "Checking this host's certificate…"));
  try {
    const outcome = await fetchStatus();
    const platform = detectPlatform({
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints,
    });
    render(describeTrust(outcome, { hostname: location.hostname }), platform);
  } catch {
    renderFailure();
  }
}

load();
