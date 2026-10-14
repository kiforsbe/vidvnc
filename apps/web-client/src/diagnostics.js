import { CODEC_LABELS } from './codec-preferences.js';
import { profileTooltip, targetBitrateText } from './profile-labels.js';
import { fetchDiagnostics, takeDiagnosticsCapability } from './diagnostics-auth.js';
import {
  countdown,
  describeState,
  detailRows,
  latencySignature,
  resultRows,
  stateLine,
} from './latency-report.js';
import { showProbe } from './latency-probe-page.js';
let capability = takeDiagnosticsCapability(location, history);
const $ = (id) => document.getElementById(id);
const fmt = (value, digits = 1) =>
  typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '—';
const ns = 'http://www.w3.org/2000/svg';
let selectedStream = new URL(location.href).searchParams.get('stream');
$('diagnosticStream').addEventListener('change', (event) => {
  selectedStream = event.target.value;
  latencyNotice = null;
  const url = new URL(location.href);
  url.searchParams.set('stream', selectedStream);
  history.replaceState(null, '', url);
});
function element(name, attrs, text) {
  const node = document.createElementNS(ns, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}
function chart(id, history, now, series, minimum, unit) {
  const svg = $(id);
  svg.replaceChildren();
  const start = now - 120000;
  const samples = history.filter((s) => s.at >= start);
  const maximum = Math.max(
    minimum,
    ...samples.flatMap((s) =>
      series
        .filter((v) => v.source === s.source)
        .map((v) => (typeof s[v.key] === 'number' ? s[v.key] * 1.1 : 0)),
    ),
  );
  const x = (time) => 48 + ((time - start) / 120000) * 535;
  const y = (value) => 208 - (value / maximum) * 180;
  for (let i = 0; i <= 4; i++) {
    const value = (maximum * i) / 4;
    svg.append(element('line', { x1: 48, x2: 583, y1: y(value), y2: y(value), class: 'grid' }));
    svg.append(element('text', { x: 40, y: y(value) + 4, 'text-anchor': 'end' }, value.toFixed(1)));
  }
  svg.append(
    element('text', { x: 48, y: 16 }, unit),
    element('text', { x: 48, y: 234 }, '−120 s'),
    element('text', { x: 583, y: 234, 'text-anchor': 'end' }, 'now'),
  );
  for (const line of series) {
    let d = '',
      previous = null;
    for (const sample of samples.filter((s) => s.source === line.source)) {
      if (typeof sample[line.key] !== 'number') {
        previous = null;
        continue;
      }
      d += `${previous && sample.at - previous < 5000 ? 'L' : 'M'}${x(sample.at).toFixed(1)},${y(sample[line.key]).toFixed(1)} `;
      previous = sample.at;
    }
    svg.append(
      element('path', {
        d,
        fill: 'none',
        stroke: line.color,
        'stroke-width': 2.5,
        'stroke-dasharray': line.dash || 'none',
      }),
    );
  }
}
// Latency measurement: a sentence from the last click that the snapshot can't show (a busy
// server, for example), kept until the next click or stream change.
let latencyNotice = null;
let latencyActive = false;
let latencyProbe = null;
// The probe page while it is shown full screen, and the measurement it is shown for once the
// server has accepted it. It closes when the snapshot no longer shows that measurement active.
let probePage = null;
let probeId = null;
function cells(tag, values) {
  const row = document.createElement('tr');
  for (const value of values) {
    const cell = document.createElement(tag);
    cell.textContent = value;
    row.append(cell);
  }
  return row;
}
function renderLatency(probe) {
  const active = probe?.active ?? null;
  const history = probe?.history ?? [];
  latencyActive = active !== null;
  $('measureLatency').disabled = latencyActive || probePage !== null || !selectedStream;
  latencyProbe = probe;
  $('latencyState').textContent = stateLine(probe, latencyNotice);
  const signature = JSON.stringify(history);
  if ($('latency').dataset.history === signature) return;
  $('latency').dataset.history = signature;
  const newest = history.find((run) => run.state === 'done');
  $('latencyTable').hidden = !newest;
  $('latencyTable').tBodies[0].replaceChildren(
    ...(newest ? resultRows(newest.results).map((row) => cells('td', row)) : []),
  );
  $('latencyDetails').replaceChildren(
    ...(newest
      ? detailRows(newest.results).map(([label, value]) => {
          const item = document.createElement('div');
          const term = document.createElement('dt');
          const detail = document.createElement('dd');
          term.textContent = label;
          detail.textContent = value;
          item.append(term, detail);
          return item;
        })
      : []),
  );
  $('latencyHistoryHeading').hidden = !history.length;
  $('latencyHistory').replaceChildren(
    ...history.map((run) => {
      const item = document.createElement('li');
      const when = new Date(run.endedAt ?? run.requestedAt).toLocaleTimeString();
      item.textContent = `${when} · ${describeState(run)}`;
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.textContent = 'Copy as JSON';
      copy.onclick = () =>
        navigator.clipboard?.writeText(JSON.stringify(run, null, 2)).catch(() => {});
      item.append(copy);
      return item;
    }),
  );
}
function latencyFailed(text) {
  latencyNotice = { text, seen: latencySignature(latencyProbe) };
}
function cancelLatency(id) {
  return fetch('/api/diagnostics/latency-probe/cancel', {
    method: 'POST',
    headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}
$('measureLatency').addEventListener('click', async () => {
  if (!capability || !selectedStream || latencyActive || probePage) return;
  $('measureLatency').disabled = true;
  latencyNotice = null;
  // Full screen first, while the click still allows it; the measurement starts only once the
  // probe page is showing. Esc leaves full screen and cancels.
  let id = null;
  let left = false;
  $('latencyCountdown').textContent = countdown(null);
  try {
    probePage = await showProbe($('latencyProbe'), {
      onExit: () => {
        left = true;
        probePage = probeId = null;
        if (id) cancelLatency(id);
      },
    });
  } catch {
    latencyFailed("This browser can't show the probe page full screen.");
    $('latencyState').textContent = latencyNotice.text;
    $('measureLatency').disabled = false;
    return;
  }
  try {
    const response = await fetch('/api/diagnostics/latency-probe', {
      method: 'POST',
      headers: { authorization: `Bearer ${capability}`, 'content-type': 'application/json' },
      body: JSON.stringify({ streamId: selectedStream }),
      signal: AbortSignal.timeout(3000),
    });
    const text =
      response.status === 409
        ? 'A measurement is already running.'
        : response.status === 404
          ? "That stream isn't live."
          : response.ok
            ? null
            : "Couldn't start the measurement.";
    if (text) latencyFailed(text);
    else {
      latencyActive = true;
      id = (await response.json()).id;
    }
  } catch {
    latencyFailed("Couldn't start the measurement.");
  }
  if (!id) {
    probePage?.close();
    probePage = null;
  } else if (left) cancelLatency(id);
  else {
    probeId = id;
    $('latencyCountdown').textContent = countdown({ state: 'requested' });
  }
  $('latencyState').textContent = latencyNotice?.text ?? 'Waiting for the viewer…';
  $('measureLatency').disabled = latencyActive || probePage !== null;
});
async function refresh() {
  if (!capability) {
    $('state').textContent = 'Reopen Diagnostics from the host';
    $('state').className = 'stale';
    return;
  }
  try {
    const requestedStream = selectedStream;
    const watching = probeId;
    const response = await fetchDiagnostics(
      fetch,
      requestedStream,
      capability,
      AbortSignal.timeout(3000),
    );
    if (response.status === 403) capability = null;
    if (!response.ok) throw new Error('Diagnostics unavailable');
    const data = await response.json();
    if (requestedStream !== selectedStream) return;
    if (data.streams) {
      $('stream-picker').hidden = false;
      selectedStream ??= data.selectedStreamId;
      const options = [...data.streams];
      if (selectedStream && !options.some((stream) => stream.id === selectedStream))
        options.unshift({ id: selectedStream, label: 'Stream ended' });
      const picker = $('diagnosticStream');
      const signature = JSON.stringify(options);
      if (picker.dataset.options !== signature) {
        picker.replaceChildren(
          ...options.map((stream) => {
            const option = document.createElement('option');
            option.value = stream.id;
            option.textContent = stream.label;
            return option;
          }),
        );
        picker.dataset.options = signature;
      }
      picker.value = selectedStream ?? '';
      $('latency').hidden = !('latencyProbe' in data);
      // The measurement ended (done, failed or expired): leave full screen and show it.
      if (watching && watching === probeId && data.latencyProbe?.active?.id !== watching) {
        probePage?.close();
        probePage = probeId = null;
      }
      renderLatency(data.latencyProbe);
      if (probePage && watching === probeId)
        $('latencyCountdown').textContent = countdown(data.latencyProbe?.active ?? null);
    }
    const serverFresh = data.serverAgeMs !== null && data.serverAgeMs < 4000;
    const clientFresh = data.clientAgeMs !== null && data.clientAgeMs < 6000;
    const s = serverFresh ? data.server || {} : {},
      c = clientFresh ? data.client || {} : {};
    const sessionAudio = data.sessionAudio;
    const audioServer = sessionAudio
      ? sessionAudio.serverAgeMs < 4000
        ? sessionAudio.server || {}
        : {}
      : s;
    const audioClient = sessionAudio
      ? sessionAudio.clientAgeMs < 6000
        ? sessionAudio.client || {}
        : {}
      : c;
    const profile = data.configuration?.profile,
      audio = sessionAudio?.configuration?.audio ?? data.configuration?.audio;
    const display = data.configuration?.display;
    const encoder = data.configuration?.encoder;
    $('source-display').textContent = display
      ? `${serverFresh ? 'Source display' : 'Last selected source'}: ${display.number ? display.number + ' · ' : ''}${display.name} · ${fmt(display.width, 0)} × ${fmt(display.height, 0)}${display.primary ? ' · Primary' : ''}`
      : 'Source display: unavailable';
    $('profile').textContent = profile
      ? `${serverFresh ? 'Current' : 'Last selected'} profile: ${profile.label ?? profile.name}`
      : 'Profile: waiting for a session…';
    $('profile').title = profile ? profileTooltip(profile) : '';
    const codecLabel = CODEC_LABELS[data.configuration?.codec] ?? 'H.264';
    $('profile-settings').textContent = profile
      ? `Targets: ${fmt(profile.width, 0)} × ${fmt(profile.height, 0)} · ${fmt(profile.fps, 0)} fps · ${codecLabel} ${targetBitrateText(profile)} · ${audio?.enabled ? `${audio.codec} ${fmt(audio.bitrateKbps, 0)} kbit/s ${audio.channels === 1 ? 'mono' : 'stereo'}` : 'Audio off'}`
      : '';
    $('encoder').textContent = encoder
      ? `Encoder: ${encoder.label ?? encoder.backend ?? 'Unknown'}${encoder.element ? ' · ' + encoder.element : ''}`
      : 'Encoder: waiting for a worker…';
    $('state').className = serverFresh && clientFresh ? '' : 'stale';
    $('state').textContent =
      `${serverFresh ? 'Server live' : 'Waiting for server frames'} · ${clientFresh ? 'Browser live' : 'Waiting for browser samples'}${data.logError ? ' · Log write error: ' + data.logError : ''}`;
    $('rates').textContent = `${fmt(s.captureFps)} → ${fmt(s.encodeFps)} → ${fmt(c.decodeFps)}`;
    $('bandwidth').textContent = `${fmt(s.encodedMbps, 2)} / ${fmt(c.receiveMbps, 2)}`;
    $('timing').textContent = `${fmt(s.encodeMeanMs)} / ${fmt(c.decodeMs)}`;
    const numbers = [
      [
        'Largest encoded frame',
        fmt(s.maxFrameBytes === undefined ? null : s.maxFrameBytes / 1024) + ' KiB',
      ],
      ['Maximum capture gap', fmt(s.captureGapMaxMs) + ' ms'],
      ['Maximum encode residence', fmt(s.encodeMaxMs) + ' ms'],
      ['Unmatched encoder inputs (bounded)', fmt(s.pendingFrames, 0)],
      ['QoS-reported drops (max)', fmt(s.qosDroppedMax, 0)],
      ['Browser frames dropped (total)', fmt(c.framesDropped, 0)],
      ['Packets lost (total)', fmt(c.packetsLost, 0)],
      ['Packet jitter', fmt(c.jitterMs) + ' ms'],
      ['Jitter-buffer delay', fmt(c.jitterBufferMs) + ' ms'],
      ['Network round trip', fmt(c.rttMs) + ' ms'],
      ['Browser freeze count', fmt(c.freezeCount, 0)],
      ['Browser freeze duration', fmt(c.freezeSeconds) + ' s'],
      ['Audio encoded packets', fmt(audioServer.audioEncodedPackets, 0)],
      ['Audio encoded bytes', fmt(audioServer.audioEncodedBytes, 0)],
      ['Audio packets lost', fmt(audioClient.audioPacketsLost, 0)],
      ['Audio concealed samples', fmt(audioClient.audioConcealedSamples, 0)],
    ];
    numbers.push(
      ['Complete frames received / s', fmt(c.completeFrameFps)],
      ['PLI / FIR requests', `${fmt(c.pliCount, 0)} / ${fmt(c.firCount, 0)}`],
      ['Encoder force-key-unit events', fmt(s.forceKeyUnitEvents, 0)],
      [
        'Encoded / decoded keyframes',
        `${fmt(s.encodedKeyframes, 0)} / ${fmt(c.keyFramesDecoded, 0)}`,
      ],
      ['Actual H.264 SPS profile / level', `${fmt(s.spsProfile, 0)} / ${fmt(s.spsLevel, 0)}`],
      [
        'Video element paused / ready state',
        `${fmt(c.videoPaused, 0)} / ${fmt(c.videoReadyState, 0)}`,
      ],
    );
    $('numbers').replaceChildren(
      ...numbers.map(([label, value]) => {
        const group = document.createElement('div'),
          term = document.createElement('dt'),
          description = document.createElement('dd');
        term.textContent = label;
        description.textContent = value;
        group.append(term, description);
        return group;
      }),
    );
    const transport = [
      ['Video RTP peak bytes / 1 ms', fmt(s.videoRtpPeak1msBytes, 0)],
      ['ICE input peak bytes / 1 ms', fmt(s.iceInputPeak1msBytes, 0)],
      ['ICE input peak bytes / 10 ms', fmt(s.iceInputPeak10msBytes, 0)],
      ['RTX sender elements', fmt(s.rtxSenders, 0)],
      ['RTX requests / packets sent', `${fmt(s.rtxRequests, 0)} / ${fmt(s.rtxPackets, 0)}`],
      ['Browser NACK / interval video loss', `${fmt(c.nackCount, 0)} / ${fmt(c.lostInterval, 0)}`],
      ['Largest queue (sampled bytes)', fmt(s.queueMaxBytesSampled, 0)],
      ['Largest queue (sampled ms)', fmt(s.queueMaxMsSampled)],
      [
        'Burst window truncations (RTP / ICE)',
        `${fmt(s.videoRtpWindowTruncated, 0)} / ${fmt(s.iceInputWindowTruncated, 0)}`,
      ],
    ];
    $('transport-numbers').replaceChildren(
      ...transport.map(([label, value]) => {
        const group = document.createElement('div'),
          term = document.createElement('dt'),
          description = document.createElement('dd');
        term.textContent = label;
        description.textContent = value;
        group.append(term, description);
        return group;
      }),
    );
    chart(
      'fps',
      data.history || [],
      data.at,
      [
        { source: 'server', key: 'captureFps', color: '#7cb8ff' },
        { source: 'server', key: 'encodeFps', color: '#72dec0', dash: '7 4' },
        { source: 'client', key: 'decodeFps', color: '#dcaaff', dash: '2 4' },
      ],
      40,
      'frames/s',
    );
    chart(
      'mbps',
      data.history || [],
      data.at,
      [
        { source: 'server', key: 'encodedMbps', color: '#72dec0' },
        { source: 'client', key: 'receiveMbps', color: '#dcaaff', dash: '7 4' },
      ],
      8,
      'Mbit/s',
    );
  } catch {
    $('state').textContent = capability
      ? 'Server unreachable · reconnect or restart sharing'
      : 'Reopen Diagnostics from the host';
    $('state').className = 'stale';
    $('profile').textContent = 'Current profile unavailable · server unreachable';
    $('profile-settings').textContent = '';
  } finally {
    if (capability) setTimeout(refresh, 1000);
  }
}
refresh();
