import { bindPasswordEntry, normalizePassword } from './password-entry.js';
import {
  browserInstallationId,
  forgetApprovedCredential,
  loadApprovedCredential,
  saveApprovedCredential,
} from './approved-client.js';
import { consumeConnectionKeyFromLocation } from './connection-link.js';
const $ = (id) => document.getElementById(id);
let scannedConnectionKey = consumeConnectionKeyFromLocation(location, history);
let clientInitialized = false;
window.addEventListener('hashchange', () => {
  const key = consumeConnectionKeyFromLocation(location, history);
  if (!key) return;
  scannedConnectionKey = key;
  if (clientInitialized) showScannedConnectionKey();
});
// The page can be reached over either listener, so the note about pairing's transport
// says whichever one is actually true rather than staying fixed at the plaintext-only
// wording that predates HTTPS support.
$('networkScheme').textContent =
  location.protocol === 'https:' ? 'Pairing uses HTTPS.' : 'Pairing uses HTTP.';
bindPasswordEntry($('password'));
let connecting = false,
  connectionAttempt = 0,
  registrationAttempt = 0,
  registrationTicket = null,
  approvedCredential = null,
  viewer = null,
  viewerStyle = null,
  pendingSessionId = null;
const status = (text) => ($('status').textContent = text);
function showAuthentication(mode) {
  for (const id of ['connectForm', 'registerForm', 'approvalPending', 'signInForm'])
    $(id).hidden = id !== mode;
  if (mode === 'connectForm') {
    $('keyIntro').textContent = 'Enter a connection or client setup key shown on your computer.';
  }
  if (mode === 'signInForm' && approvedCredential) {
    $('signInUsername').value = approvedCredential.username;
    $('signInPassword').value = '';
  }
}
function showPreferredAuthentication() {
  showAuthentication(approvedCredential ? 'signInForm' : 'connectForm');
}
function showScannedConnectionKey() {
  // Scanning only saves typing: the person explicitly chooses whether to use
  // the key, preserving the browser gesture that starts the stream.
  showAuthentication('connectForm');
  $('password').value = scannedConnectionKey;
  $('password').dispatchEvent(new Event('input', { bubbles: true }));
  status('Connection key is ready. Select Connect to continue.');
}
function browserPlatform() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  if (/iphone/i.test(platform) || /iphone/i.test(navigator.userAgent)) return 'iPhone';
  if (/ipad/i.test(platform) || /ipad/i.test(navigator.userAgent)) return 'iPad';
  if (/win/i.test(platform)) return 'Windows device';
  if (/mac/i.test(platform)) return 'Mac';
  if (/android/i.test(platform) || /android/i.test(navigator.userAgent)) return 'Android device';
  return platform || 'Browser device';
}
function browserDescription() {
  const brands = navigator.userAgentData?.brands
    ?.map((brand) => brand.brand)
    .filter((brand) => !/not.?a.?brand/i.test(brand));
  return ((brands?.join(', ') || navigator.userAgent) + ` on ${browserPlatform()}`).slice(0, 120);
}
async function api(route, body = {}) {
  const response = await fetch('/api/' + route, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const failure = await response.json();
    throw Object.assign(new Error(failure.error || 'Connection failed'), {
      status: response.status,
      code: failure.code,
    });
  }
  return response.status === 204 ? null : response.json();
}
async function retireAdmission(sessionId) {
  if (!sessionId) return;
  await fetch('/api/disconnect', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + sessionId },
    body: '{}',
    keepalive: true,
  }).catch(() => {});
}
async function loadViewerStyle() {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/viewer/style.css';
  viewerStyle = link;
  document.head.append(link);
  await new Promise((resolve, reject) => {
    link.onload = resolve;
    link.onerror = () => reject(new Error('Viewer styling is unavailable. Sign in again.'));
  });
}
function clearViewerMounts() {
  viewerStyle?.remove();
  viewerStyle = null;
  $('viewerHeaderMount').replaceChildren();
  $('viewerMount').replaceChildren();
}
async function returnToLogin(
  message = 'Disconnected. Your PC is no longer being shared with this browser.',
) {
  connectionAttempt++;
  const active = viewer;
  viewer = null;
  await active?.disconnect(message).catch(() => {});
  if (pendingSessionId) await retireAdmission(pendingSessionId);
  pendingSessionId = null;
  clearViewerMounts();
  $('welcome').hidden = false;
  showPreferredAuthentication();
  status(message);
}
async function enterViewer(result, attempt) {
  if (attempt !== connectionAttempt) return retireAdmission(result.sessionId);
  pendingSessionId = result.sessionId;
  try {
    const response = await fetch('/viewer/fragment.html', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('Viewer is unavailable. Sign in again.');
    const fragment = document.createElement('template');
    fragment.innerHTML = await response.text();
    const identity = fragment.content.querySelector('#sessionIdentity');
    const disconnect = fragment.content.querySelector('#disconnect');
    const panel = fragment.content.querySelector('#viewer');
    if (!identity || !disconnect || !panel)
      throw new Error('Viewer is unavailable. Sign in again.');
    $('viewerHeaderMount').replaceChildren(identity, disconnect);
    $('viewerMount').replaceChildren(panel);
    await loadViewerStyle();
    const { createViewer } = await import('/viewer/app.js');
    viewer = createViewer({ onExit: returnToLogin });
    await viewer.start(result);
    pendingSessionId = null;
    $('password').value = '';
    $('password').dispatchEvent(new Event('input'));
    $('signInPassword').value = '';
  } catch (error) {
    const active = viewer;
    viewer = null;
    if (active) await active.disconnect(error.message).catch(() => {});
    else await retireAdmission(result.sessionId);
    pendingSessionId = null;
    clearViewerMounts();
    throw error;
  }
}
window.addEventListener('pagehide', () => {
  if (pendingSessionId) void retireAdmission(pendingSessionId);
});
$('connectForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (connecting) return;
  const password = normalizePassword($('password').value);
  if (!password) {
    $('passwordError').textContent = 'Enter the eight-character connection key.';
    $('password').setAttribute('aria-invalid', 'true');
    $('password').focus();
    return;
  }
  connecting = true;
  $('connect').disabled = true;
  const attempt = ++connectionAttempt;
  try {
    $('passwordError').textContent = '';
    $('password').removeAttribute('aria-invalid');
    status('Connecting to your desktop…');
    const started = await api('key-start', { key: password, profile: 'auto', audio: 'on' });
    if (started.registrationTicket) {
      registrationTicket = started.registrationTicket;
      $('password').value = '';
      $('deviceName').value = browserPlatform();
      $('registerUsername').value = approvedCredential?.username || '';
      $('registerPassword').value = '';
      $('confirmPassword').value = '';
      showAuthentication('registerForm');
      status('Create the sign-in for this browser, then request approval.');
      return;
    }
    await enterViewer(started, attempt);
  } catch (error) {
    if (attempt === connectionAttempt) {
      await returnToLogin(error.message);
      if (error.status === 401) {
        showAuthentication('connectForm');
        $('passwordError').textContent = 'Connection key not recognized. Try again.';
        $('password').setAttribute('aria-invalid', 'true');
        $('password').focus();
      }
    }
  } finally {
    connecting = false;
    $('connect').disabled = false;
  }
});

$('cancelRegistration').onclick = () => {
  registrationTicket = null;
  showAuthentication('connectForm');
  status('Ready to connect.');
};

$('registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (connecting || !registrationTicket) return;
  const password = $('registerPassword').value;
  if (password.length < 10) {
    $('registerError').textContent = 'Use at least 10 characters for the password.';
    return;
  }
  if (password !== $('confirmPassword').value) {
    $('registerError').textContent = 'The passwords do not match.';
    return;
  }
  connecting = true;
  $('requestApproval').disabled = true;
  try {
    $('registerError').textContent = '';
    const registration = await api('approved-clients/register', {
      registrationTicket: registrationTicket,
      deviceName: $('deviceName').value,
      username: $('registerUsername').value,
      password,
      installationId: await browserInstallationId(),
      client: browserDescription(),
    });
    registrationTicket = null;
    $('registerPassword').value = '';
    $('confirmPassword').value = '';
    showAuthentication('approvalPending');
    status('Waiting for approval on the host.');
    pollForApproval(registration);
  } catch (error) {
    $('registerError').textContent = error.message;
  } finally {
    connecting = false;
    $('requestApproval').disabled = false;
  }
});

async function pollForApproval(registration) {
  const attempt = ++registrationAttempt;
  while (attempt === registrationAttempt) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    try {
      const result = await api('approved-clients/status', registration);
      if (result.state === 'pending') continue;
      if (result.state === 'rejected') {
        showAuthentication('connectForm');
        $('passwordError').textContent = 'The host rejected this approval request.';
        status('Approval was rejected.');
        return;
      }
      if (result.state === 'approved' && result.clientSecret) {
        approvedCredential = await saveApprovedCredential(result);
        showAuthentication('signInForm');
        status('Approved. Sign in with your username and password.');
        return;
      }
      throw new Error('This approval was already claimed. Start setup again on this browser.');
    } catch (error) {
      if (attempt !== registrationAttempt) return;
      showAuthentication('connectForm');
      $('passwordError').textContent = error.message;
      status('Approval could not be completed.');
      return;
    }
  }
}

$('cancelPending').onclick = () => {
  registrationAttempt++;
  showPreferredAuthentication();
  status('Approval polling stopped.');
};

$('signInForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (connecting || !approvedCredential) return;
  connecting = true;
  $('signIn').disabled = true;
  const attempt = ++connectionAttempt;
  try {
    $('signInError').textContent = '';
    status('Signing in to your desktop…');
    const result = await api('approved-clients/sign-in', {
      ...approvedCredential,
      username: $('signInUsername').value,
      password: $('signInPassword').value,
      profile: 'auto',
      audio: 'on',
    });
    await enterViewer(result, attempt);
  } catch (error) {
    if (attempt === connectionAttempt) {
      await returnToLogin(error.message);
      $('signInError').textContent =
        error.code === 'approved-client-in-use'
          ? 'This approved browser credential is already in use. Disconnect its current session or ask the host to revoke it.'
          : error.status === 401
            ? 'Username or password not recognized.'
            : error.message;
    }
  } finally {
    connecting = false;
    $('signIn').disabled = false;
  }
});

$('useConnectionKey').onclick = () => {
  showAuthentication('connectForm');
  $('password').focus();
  status('Enter a connection key from the host.');
};

$('forgetClient').onclick = async () => {
  try {
    await forgetApprovedCredential();
  } catch {
    /* Storage may already be unavailable. */
  }
  approvedCredential = null;
  showAuthentication('connectForm');
  status('This browser is no longer remembered as an approved client.');
};
Promise.all([
  fetch('/api/info').then((response) => {
    if (!response.ok) throw new Error('Unable to reach the server.');
    return response.json();
  }),
  loadApprovedCredential(),
])
  .then(([info, credential]) => {
    $('serverName').textContent = info.publicName;
    document.querySelectorAll('.server-name').forEach((element) => {
      element.textContent = info.publicName;
    });
    approvedCredential = credential;
    clientInitialized = true;
    showPreferredAuthentication();

    if (scannedConnectionKey) showScannedConnectionKey();
    else status('Ready to connect.');
  })
  .catch(() => {
    $('connect').disabled = true;
    $('signIn').disabled = true;
    status('Unable to reach the server.');
  });
