import { bindPasswordEntry, normalizePassword } from './password-entry.js';
import {
  browserInstallationId,
  forgetApprovedCredential,
  loadApprovedCredential,
  saveApprovedCredential,
} from './approved-client.js';
import { summarizeReceiver, summarizeAudioReceiver } from './receiver-stats.js';
import { StreamSubscriptions } from './stream-subscriptions.js';
import { videoCodecPreferences } from './codec-preferences.js';
import { bitrateText, profileTooltip } from './profile-labels.js';
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
const toolbarIcons = {
  control:
    '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 13h.01M11 13h.01M15 13h.01M8 16h8"/>',
  sound: '<path d="M11 4 6 8H3v8h3l5 4zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14"/>',
  muted: '<path d="M11 4 6 8H3v8h3l5 4zM16 9l5 6M21 9l-5 6"/>',
  pictureInPicture:
    '<rect x="3" y="5" width="18" height="14" rx="2"/><rect x="11" y="11" width="8" height="6" rx="1"/>',
  expand: '<path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5"/>',
  collapse: '<path d="M3 8h5V3M16 3v5h5M21 16h-5v5M8 21v-5H3"/>',
};
function toolbarButton(id, label, icon) {
  const button = $(id);
  button.setAttribute('aria-label', label);
  button.title = label;
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${toolbarIcons[icon]}</svg>`;
}
function renderControl() {
  $('control').disabled = !controlAllowed || document.pictureInPictureElement === $('video');
  $('control').setAttribute('aria-pressed', String(enabled));
  toolbarButton(
    'control',
    enabled ? 'Release keyboard & mouse (Esc)' : 'Enable keyboard & mouse',
    'control',
  );
}
function renderPictureInPicture() {
  const video = $('video');
  const button = $('pictureInPicture');
  const supported =
    document.pictureInPictureEnabled && typeof video.requestPictureInPicture === 'function';
  const active = document.pictureInPictureElement === video;
  button.hidden = !supported;
  button.disabled =
    !active && (!video.srcObject || video.readyState === HTMLMediaElement.HAVE_NOTHING);
  button.setAttribute('aria-pressed', String(active));
  toolbarButton(
    'pictureInPicture',
    active ? 'Exit picture-in-picture' : 'Picture-in-picture',
    'pictureInPicture',
  );
}
function renderAudio() {
  const active = !$('audioToggle').disabled && !$('audio').muted;
  $('audioToggle').setAttribute('aria-pressed', String(active));
  toolbarButton(
    'audioToggle',
    $('audioToggle').disabled
      ? 'Desktop audio unavailable'
      : active
        ? 'Mute desktop audio'
        : 'Unmute desktop audio',
    active ? 'sound' : 'muted',
  );
}
function renderFullscreen() {
  toolbarButton(
    'fullscreen',
    document.fullscreenElement
      ? 'Exit full screen (Ctrl/⌘+Shift+F)'
      : 'Full screen (Ctrl/⌘+Shift+F)',
    document.fullscreenElement ? 'collapse' : 'expand',
  );
}
bindPasswordEntry($('password'));
let token,
  subscriptions,
  pc,
  channel,
  heartbeat,
  ping,
  playback,
  enabled = false,
  controlAllowed = false,
  connecting = false,
  reconnecting = false,
  connectionAttempt = 0,
  registrationAttempt = 0,
  registrationTicket = null,
  approvedCredential = null,
  connectionMode = 'session-key',
  catalog = null,
  currentRequest = { profile: 'auto', audio: 'on' };
const status = (text) => ($('status').textContent = text);
function showAuthentication(mode) {
  for (const id of ['connectForm', 'registerForm', 'approvalPending', 'signInForm'])
    $(id).hidden = id !== mode;
  if (mode === 'connectForm') {
    $('keyIntro').textContent =
      connectionMode === 'approved-only'
        ? 'Enter a client setup key shown on your computer.'
        : connectionMode === 'one-time-keys'
          ? 'Enter a one-time connection key or client setup key shown on your computer.'
          : 'Enter the session, one-time, or client setup key shown on your computer.';
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
function fitVideo() {
  const video = $('video');
  if (!video.videoWidth || !video.videoHeight) return;
  const ratio = video.videoWidth / video.videoHeight;
  $('stage').style.setProperty('--video-ratio', String(ratio));
  $('stage').style.setProperty(
    '--video-fit-width',
    `${Math.max(1, (window.visualViewport?.height || window.innerHeight) - ($('stage').getBoundingClientRect().top + window.scrollY) - 4) * ratio}px`,
  );
}
$('video').addEventListener('loadedmetadata', fitVideo);
$('video').addEventListener('loadedmetadata', renderPictureInPicture);
$('video').addEventListener('resize', fitVideo);
window.addEventListener('resize', fitVideo);
window.visualViewport?.addEventListener('resize', fitVideo);
new ResizeObserver(fitVideo).observe(document.querySelector('.app-header'));
async function api(route, body = {}) {
  const response = await fetch('/api/' + route, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
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
function send(message) {
  if (channel?.readyState !== 'open') return false;
  if (channel.bufferedAmount > 65536) {
    disconnect('Connection is too slow for safe control. Please reconnect.');
    return false;
  }
  channel.send(JSON.stringify(message));
  return true;
}
function release() {
  send({ type: 'release' });
  enabled = false;
  renderControl();
}
async function disconnect(
  message = 'Disconnected. Your PC is no longer being shared with this browser.',
) {
  connectionAttempt++;
  if (document.pictureInPictureElement === $('video'))
    await document.exitPictureInPicture().catch(() => {});
  release();
  clearInterval(heartbeat);
  clearInterval(ping);
  clearInterval(playback);
  const retiring = closeMedia({ deferPeers: true });
  const old = token;
  token = null;
  $('video').srcObject = null;
  renderPictureInPicture();
  $('audio').srcObject = null;
  $('sessionIdentity').hidden = true;
  $('disconnect').hidden = true;
  $('qualityPanel').open = false;
  $('viewer').hidden = true;
  $('welcome').hidden = false;
  $('connect').disabled = false;
  showPreferredAuthentication();
  status(message);
  if (old)
    fetch('/api/disconnect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${old}` },
      body: '{}',
      keepalive: true,
      signal: AbortSignal.timeout(5000),
    })
      .catch(() => {})
      .finally(() => retiring?.close());
  else retiring?.close();
}
function gatheringComplete(connection) {
  if (connection.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      connection.removeEventListener('icegatheringstatechange', changed);
      reject(new Error('Local network discovery timed out.'));
    }, 10000);
    function changed() {
      if (connection.iceGatheringState === 'complete') {
        clearTimeout(timer);
        connection.removeEventListener('icegatheringstatechange', changed);
        resolve();
      }
    }
    connection.addEventListener('icegatheringstatechange', changed);
  });
}
function closeMedia({ deferPeers = false } = {}) {
  const retiring = subscriptions;
  retiring?.close(!deferPeers);
  subscriptions = null;
  clearInterval(ping);
  clearInterval(playback);
  const previous = pc;
  pc = null;
  if (!retiring || !deferPeers) channel?.close();
  channel = null;
  if (!retiring || !deferPeers) previous?.close();
  $('video').srcObject = null;
  renderPictureInPicture();
  $('audio').srcObject = null;
  return retiring;
}
function renderQuality(result) {
  const list = $('streamProfile');
  list.replaceChildren();
  const selected = currentRequest.profile;
  const addProfile = (parent, id, name, description, detail = '', tooltip = '') => {
    const row = document.createElement('label');
    row.className = 'profile-choice';
    if (tooltip) row.title = tooltip;
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'streamProfile';
    radio.value = id;
    radio.checked = id === selected;
    const copy = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = name;
    copy.append(title);
    for (const text of [description, detail])
      if (text) {
        const line = document.createElement('small');
        line.textContent = text;
        copy.append(line);
      }
    row.append(radio, copy);
    parent.append(row);
  };
  addProfile(list, 'auto', 'Automatic', 'Use the host’s default profile');
  for (const p of catalog.profiles)
    addProfile(
      list,
      p.id,
      p.name,
      '',
      `${p.width} × ${p.height} · ${p.fps} fps · ${bitrateText(p)}`,
      profileTooltip(p),
    );
  $('qualityHeading').textContent = 'Allowed by ' + catalog.serverName;
  $('displayName').textContent = catalog.display?.name || 'Primary display';
  const picker = document.querySelector('.display-picker');
  picker.replaceChildren();
  const displays = catalog.displays ?? [
    catalog.display ?? { id: 'primary', name: 'Primary display' },
  ];
  displays.forEach((display, index) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'display-chip';
    chip.setAttribute('aria-current', String(display.id === catalog.display?.id));
    const number = document.createElement('span');
    number.className = 'display-number';
    number.textContent = String(display.number ?? index + 1);
    chip.append(number, document.createTextNode(display.name));
    chip.addEventListener('click', () => {
      if (
        display.id !== catalog.display?.id ||
        (subscriptions && !subscriptions.rows.has(display.id))
      )
        reconnectStream({
          ...(subscriptions?.rows.get(display.id)?.request ?? currentRequest),
          displayId: display.id,
          inventoryRevision: catalog.inventoryRevision,
        });
    });
    picker.append(chip);
  });
  $('streamTarget').textContent =
    result.profile.width +
    ' × ' +
    result.profile.height +
    ' · ' +
    result.profile.fps +
    ' fps target';
  $('qualitySummary').textContent =
    'Quality: ' +
    (currentRequest.profile === 'auto'
      ? 'Automatic'
      : catalog.profiles.find((p) => p.id === currentRequest.profile)?.name ||
        result.profile.label ||
        result.profile.name);
  $('qualityError').textContent = '';
}
$('qualityForm').addEventListener('change', (event) => {
  if (event.target.name === 'streamProfile') $('qualityForm').requestSubmit();
});
$('qualityPanel').addEventListener('toggle', () => {
  if ($('qualityPanel').open) release();
});
$('qualityForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  await reconnectStream({
    profile: document.querySelector('input[name="streamProfile"]:checked')?.value || 'auto',
    audio: currentRequest.audio,
    displayId: catalog.display?.id === 'primary' ? undefined : catalog.display?.id,
    inventoryRevision: catalog.inventoryRevision,
  });
});
async function reconnectStream(request) {
  if (connecting || !token) return;
  if (subscriptions) {
    connecting = true;
    release();
    try {
      await subscriptions.select(request);
      $('qualityPanel').open = false;
    } catch (error) {
      $('qualityError').textContent = error.message;
    } finally {
      connecting = false;
    }
    return;
  }
  connecting = true;
  reconnecting = true;
  $('qualityForm')
    .querySelectorAll('input')
    .forEach((input) => {
      input.disabled = true;
    });
  release();
  const attempt = ++connectionAttempt;
  try {
    const result = await api('reconnect', request);
    closeMedia();
    clearInterval(heartbeat);
    currentRequest = request;
    $('qualityPanel').open = false;
    await startStream(result, attempt);
  } catch (error) {
    if (attempt === connectionAttempt) {
      if (error.status === 403) {
        $('qualityError').textContent = error.message;
        $('qualityForm')
          .querySelectorAll('input')
          .forEach((input) => {
            input.checked = input.value === currentRequest.profile;
          });
      } else await disconnect(error.message);
    }
  } finally {
    connecting = false;
    reconnecting = false;
    $('qualityForm')
      .querySelectorAll('input')
      .forEach((input) => {
        input.disabled = false;
      });
  }
}
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
    if (!window.RTCPeerConnection) throw new Error('This browser does not support WebRTC.');
    status('Connecting to your desktop…');
    currentRequest = { profile: 'auto', audio: 'on' };
    const started = await api('key-start', { key: password, ...currentRequest });
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
    await startStream(started, attempt);
  } catch (error) {
    if (attempt === connectionAttempt) {
      await disconnect(error.message);
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
    if (!window.RTCPeerConnection) throw new Error('This browser does not support WebRTC.');
    $('signInError').textContent = '';
    status('Signing in to your desktop…');
    currentRequest = { profile: 'auto', audio: 'on' };
    const result = await api('approved-clients/sign-in', {
      ...approvedCredential,
      username: $('signInUsername').value,
      password: $('signInPassword').value,
      ...currentRequest,
    });
    await startStream(result, attempt);
  } catch (error) {
    if (attempt === connectionAttempt) {
      await disconnect(error.message);
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
async function startStream(result, attempt) {
  if (attempt !== connectionAttempt) {
    await fetch('/api/disconnect', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${result.sessionId}` },
      body: '{}',
    });
    return;
  }
  token = result.sessionId;
  const assertCurrent = () => {
    if (attempt !== connectionAttempt) throw new Error('Connection cancelled.');
  };
  catalog = await api('profiles');
  assertCurrent();
  renderQuality(result);
  $('sessionIdentity').hidden = false;
  $('disconnect').hidden = false;
  $('sessionState').textContent = 'Connecting';
  $('sessionState').classList.remove('connected');
  $('password').value = '';
  $('password').dispatchEvent(new Event('input'));
  $('signInPassword').value = '';
  $('audio').muted = false;
  $('audioToggle').disabled = !result.audio.enabled;
  renderAudio();
  if (result.mode === 'streams') {
    await startSubscriptions(result, attempt);
    return;
  }
  heartbeat = setInterval(
    () => api('heartbeat').catch(() => disconnect('Session ended. Please reconnect.')),
    5000,
  );
  const connection = (pc = new RTCPeerConnection({ iceServers: [] }));
  const transceiver = connection.addTransceiver('video', { direction: 'recvonly' });
  if (result.audio.enabled) connection.addTransceiver('audio', { direction: 'recvonly' });
  transceiver.setCodecPreferences(await videoCodecPreferences(undefined));
  channel = connection.createDataChannel('input', { ordered: true });
  channel.onmessage = (event) => {
    try {
      const state = JSON.parse(event.data);
      if (typeof state.control === 'boolean') {
        if (state.control && document.pictureInPictureElement === $('video')) release();
        else {
          enabled = state.control;
          renderControl();
        }
      }
    } catch {
      /* Ignore unknown protocol messages. */
    }
  };
  channel.onopen = () => {
    controlAllowed = true;
    renderControl();
    ping = setInterval(() => send({ type: 'ping' }), 1000);
  };
  channel.onclose = () => {
    enabled = false;
    controlAllowed = false;
    renderControl();
  };
  controlAllowed = false;
  renderControl();
  connection.ontrack = (event) => {
    if (event.track.kind === 'audio') {
      $('audio').srcObject = new MediaStream([event.track]);
      $('audio')
        .play()
        .catch(() => status('Tap the audio button to start desktop audio.'));
    } else {
      $('video').playsInline = true;
      $('video').srcObject = new MediaStream([event.track]);
      renderPictureInPicture();
      $('video')
        .play()
        .catch(() => status('Tap the desktop to start video playback.'));
    }
  };
  connection.onconnectionstatechange = () => {
    if (connection !== pc) return;
    if (connection.connectionState === 'connected') {
      $('sessionState').textContent = 'Connected';
      $('sessionState').classList.add('connected');
      status(`Connected · Waiting for video`);
    }
    if (!reconnecting && ['failed', 'disconnected'].includes(connection.connectionState))
      disconnect('Connection lost. Please reconnect.');
  };
  await connection.setLocalDescription(await connection.createOffer());
  await gatheringComplete(connection);
  assertCurrent();
  const answer = await api('offer', { sdp: connection.localDescription.sdp });
  assertCurrent();
  $('welcome').hidden = true;
  $('viewer').hidden = false;
  await connection.setRemoteDescription(answer);
  assertCurrent();
  fitVideo();
  revealDock();
  status('Starting your desktop…');
  // WebKit may suspend playback when the media element is hidden during
  // negotiation. Retry after showing the viewer, not only in ontrack.
  if ($('video').srcObject)
    $('video')
      .play()
      .catch(() => status('Tap the desktop to start video playback.'));
  const videoDeadline = Date.now() + 12000;
  let lastFrames = 0;
  let previousReceiver = null,
    previousAudioReceiver = null,
    statsBusy = false;
  playback = setInterval(async () => {
    if (pc !== connection || statsBusy) return;
    statsBusy = true;
    try {
      const stats = await connection.getStats();
      if (pc !== connection) return;
      let audioMetrics = {};
      for (const report of stats.values())
        if (report.type === 'inbound-rtp' && (report.kind || report.mediaType) === 'audio') {
          audioMetrics = summarizeAudioReceiver(report, previousAudioReceiver);
          previousAudioReceiver = report;
        }
      for (const report of stats.values())
        if (report.type === 'inbound-rtp' && (report.kind || report.mediaType) === 'video') {
          const transport = stats.get(report.transportId);
          const pair =
            stats.get(transport?.selectedCandidatePairId) ||
            [...stats.values()].find(
              (r) => r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded',
            );
          const metrics = summarizeReceiver(report, previousReceiver, pair);
          previousReceiver = report;
          const text = (value) => (value === null ? 'unavailable' : value.toFixed(1));
          $('connectionMetrics').textContent =
            `Received: ${text(metrics.receiveMbps)} Mbit/s · Decoded: ${text(metrics.decodeFps)} fps · Dropped: ${metrics.framesDropped ?? 'unavailable'} · Jitter: ${text(metrics.jitterMs)} ms · Decode: ${text(metrics.decodeMs)} ms`;
          await api('telemetry', {
            ...metrics,
            ...audioMetrics,
            videoPaused: Number($('video').paused),
            videoReadyState: $('video').readyState,
          }).catch(() => {});
          if (pc !== connection) return;
          if (report.framesDecoded > lastFrames)
            status(
              `${enabled ? 'In control' : 'View only'} · ${report.frameWidth} × ${report.frameHeight} · ${Math.round(report.framesPerSecond || 0)} fps`,
            );
          else if (Date.now() > videoDeadline)
            status(
              'Video is not advancing. Open connection details or check the server diagnostics.',
            );
          lastFrames = report.framesDecoded || 0;
          break;
        }
    } catch {
      /* Unsupported stats must never terminate playback. */
    } finally {
      statsBusy = false;
    }
  }, 2000);
}
async function startSubscriptions(result, attempt) {
  const sessionToken = token;
  const request = async (route, body = {}) => {
    const response = await fetch('/api/' + route, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionToken}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok)
      throw Object.assign(new Error((await response.json()).error), { status: response.status });
    return response.status === 204 ? null : response.json();
  };
  const peers = (subscriptions = new StreamSubscriptions({
    api: request,
    onSelect: (row) => {
      if (subscriptions !== peers) return;
      pc = row?.pc;
      channel = row?.channel;
      $('video').srcObject = row?.stream ?? null;
      renderPictureInPicture();
      if (row?.profile) {
        currentRequest = row.request;
        catalog.display = row.display;
        renderQuality(row);
      }
      if (row?.stream)
        $('video')
          .play()
          .catch(() => status('Tap the desktop to start video playback.'));
      fitVideo();
    },
    onControl: (value, allowed) => {
      if (subscriptions !== peers) return;
      controlAllowed = allowed;
      if (value !== null) {
        if (value && document.pictureInPictureElement === $('video')) release();
        else enabled = value && allowed;
      }
      renderControl();
    },
    onState: (state) => {
      if (subscriptions !== peers) return;
      const connected = state === 'connected';
      $('sessionState').textContent = connected ? 'Connected' : 'Connecting';
      $('sessionState').classList.toggle('connected', connected);
      if (['failed', 'disconnected', 'ended'].includes(state))
        status('Display stream ended. Choose a display to reconnect.');
    },
    onMetrics: (metrics) => {
      if (subscriptions !== peers) return;
      const text = (value) => (typeof value === 'number' ? value.toFixed(1) : 'unavailable');
      $('connectionMetrics').textContent =
        `Received: ${text(metrics.receiveMbps)} Mbit/s · Decoded: ${text(metrics.decodeFps)} fps · Dropped: ${metrics.framesDropped ?? 'unavailable'} · Jitter: ${text(metrics.jitterMs)} ms · Decode: ${text(metrics.decodeMs)} ms`;
      status(
        `${enabled ? 'In control' : 'View only'} · ${metrics.frameWidth ?? '—'} × ${metrics.frameHeight ?? '—'} · ${text(metrics.decodeFps)} fps`,
      );
    },
    onAudio: (stream) => {
      if (subscriptions !== peers) return;
      $('audio').srcObject = stream;
      $('audio')
        .play()
        .catch(() => status('Tap the audio button to start desktop audio.'));
    },
  }));
  controlAllowed = false;
  renderControl();
  $('welcome').hidden = true;
  $('viewer').hidden = false;
  let heartbeatBusy = false;
  heartbeat = setInterval(async () => {
    if (heartbeatBusy) return;
    heartbeatBusy = true;
    const knownIds = new Set([...peers.rows.values()].map((row) => row.id).filter(Boolean));
    try {
      const state = await request('heartbeat');
      if (subscriptions === peers) {
        peers.update(state, knownIds);
        if (state.inventoryRevision !== catalog.inventoryRevision) {
          const updated = await request('profiles');
          if (subscriptions !== peers) return;
          catalog = { ...updated, display: peers.selected?.display ?? null };
          renderQuality(peers.selected ?? result);
          if (!peers.selected) {
            $('displayName').textContent = 'Choose a display';
            $('streamTarget').textContent = '';
          }
        }
      }
    } catch {
      if (subscriptions === peers) disconnect('Session ended. Please reconnect.');
    } finally {
      heartbeatBusy = false;
    }
  }, 2000);
  await peers.select({
    ...currentRequest,
    displayId: result.display.id,
    inventoryRevision: catalog.inventoryRevision,
  });
  if (attempt !== connectionAttempt) return;
  if (result.audio.enabled)
    await peers.startAudio().catch((error) => {
      if (subscriptions === peers) {
        $('audioToggle').disabled = true;
        renderAudio();
        status(error.message);
      }
    });
  fitVideo();
  revealDock();
}
$('disconnect').onclick = () => disconnect();
$('audioToggle').onclick = async () => {
  const audio = $('audio');
  audio.muted = !audio.muted;
  renderAudio();
  if (!audio.muted) await audio.play().catch(() => {});
};
$('control').onclick = () => {
  if (document.pictureInPictureElement === $('video')) return;
  if (enabled) {
    release();
    status('Connected · View only');
    return;
  }
  if (send({ type: 'control', enabled: true })) {
    enabled = true;
    renderControl();
    $('video').focus();
    status('You’re in control · Esc releases keyboard and mouse');
  }
};
$('control').onpointerdown = (event) => event.preventDefault();
$('pictureInPicture').onclick = async () => {
  const video = $('video');
  try {
    if (document.pictureInPictureElement === video) await document.exitPictureInPicture();
    else {
      release();
      await video.requestPictureInPicture();
    }
  } catch (error) {
    status(error.message || 'Picture-in-picture is unavailable.');
  }
};
$('video').addEventListener('enterpictureinpicture', () => {
  if (enabled) release();
  renderControl();
  renderPictureInPicture();
  status('Picture-in-picture · View only');
});
$('video').addEventListener('leavepictureinpicture', () => {
  renderControl();
  renderPictureInPicture();
  status('Connected · View only');
});
$('fullscreen').onclick = async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if ($('stage').requestFullscreen) await $('stage').requestFullscreen();
    else if ($('video').webkitEnterFullscreen) $('video').webkitEnterFullscreen();
    else throw new Error('Full screen is unavailable in this browser.');
  } catch (error) {
    status(error.message);
  }
};
document.addEventListener('fullscreenchange', () => {
  fitVideo();
  renderFullscreen();
  revealDock();
  if (document.fullscreenElement && enabled) setTimeout(() => $('video').focus(), 0);
});
let dockTimer;
function revealDock() {
  $('immersiveToolbar').classList.add('visible');
  clearTimeout(dockTimer);
  dockTimer = setTimeout(() => $('immersiveToolbar').classList.remove('visible'), 2800);
}
$('stage').addEventListener('pointermove', (event) => {
  if (event.clientY - $('stage').getBoundingClientRect().top < 110) revealDock();
});
$('immersiveToolbar').addEventListener('pointerenter', revealDock);
$('stage').addEventListener('pointerdown', (event) => {
  if (event.clientY - $('stage').getBoundingClientRect().top < 60) revealDock();
});
renderControl();
renderAudio();
renderPictureInPicture();
renderFullscreen();
function position(event) {
  const video = $('video'),
    rect = video.getBoundingClientRect();
  if (!video.videoWidth || !video.videoHeight) return null;
  const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
  const width = video.videoWidth * scale,
    height = video.videoHeight * scale;
  const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
  const y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}
let lastMove = 0;
$('video').onpointermove = (event) => {
  if (!enabled || performance.now() - lastMove < 8) return;
  const point = position(event);
  if (point) {
    lastMove = performance.now();
    send({ type: 'move', ...point });
  }
};
$('video').onpointerdown = (event) => {
  if ($('video').paused && $('video').srcObject)
    $('video')
      .play()
      .catch(() => status('Video playback could not start. Please reconnect.'));
  if (!enabled || event.button > 2) return;
  const point = position(event);
  if (!point) return;
  event.preventDefault();
  $('video').focus();
  $('video').setPointerCapture(event.pointerId);
  send({ type: 'move', ...point });
  send({ type: 'button', button: event.button, down: true });
};
$('video').onpointerup = (event) => {
  if (enabled && event.button <= 2) {
    event.preventDefault();
    send({ type: 'button', button: event.button, down: false });
  }
};
$('video').onpointercancel = release;
$('video').oncontextmenu = (event) => event.preventDefault();
$('video').addEventListener(
  'wheel',
  (event) => {
    if (enabled) {
      event.preventDefault();
      send({ type: 'wheel', delta: -Math.sign(event.deltaY) * 120 });
    }
  },
  { passive: false },
);
async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if ($('stage').requestFullscreen) await $('stage').requestFullscreen();
    else if ($('video').webkitEnterFullscreen) $('video').webkitEnterFullscreen();
  } catch (error) {
    status(error.message);
  }
}
for (const type of ['keydown', 'keyup'])
  document.addEventListener(type, (event) => {
    if ($('viewer').hidden) return;
    if (
      type === 'keydown' &&
      (event.ctrlKey || event.metaKey) &&
      event.shiftKey &&
      event.code === 'KeyF'
    ) {
      event.preventDefault();
      toggleFullscreen();
      return;
    }
    if (!enabled || event.target !== $('video')) return;
    event.preventDefault();
    if (event.code === 'Escape') {
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      release();
      status('Control released.');
      return;
    }
    send({ type: 'key', code: event.code, down: type === 'keydown' });
  });
document.addEventListener('focusin', (event) => {
  if (enabled && !$('stage').contains(event.target)) release();
});
window.addEventListener('blur', release);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) release();
});
window.addEventListener('pagehide', () => disconnect());
Promise.all([
  fetch('/api/info').then((response) => {
    if (!response.ok) throw new Error('Unable to reach the server.');
    return response.json();
  }),
  loadApprovedCredential(),
])
  .then(([info, credential]) => {
    $('serverName').textContent = info.serverName;
    $('viewerName').textContent = info.serverName;
    document.querySelectorAll('.server-name').forEach((element) => {
      element.textContent = info.serverName;
    });
    connectionMode = info.connectionMode || 'session-key';
    approvedCredential = credential;
    clientInitialized = true;
    showPreferredAuthentication();

    if (scannedConnectionKey) showScannedConnectionKey();
    else status('Ready to connect.');
    if (info.media.state !== 'ready') {
      $('connect').disabled = true;
      $('signIn').disabled = true;
      status('The server’s native media worker is not available.');
    }
  })
  .catch(() => {
    $('connect').disabled = true;
    $('signIn').disabled = true;
    status('Unable to reach the server.');
  });
