import { CODEC_LABELS, VIDEO_CODECS } from '../video-codecs.mjs';
import { renewalStatus } from '../tls/certificate-facts.mjs';

const ACCESS_LABELS = { approval: 'Require host approval', available: 'Allow when available' };
const CONNECTION_MODE_LABELS = {
  'session-key': 'Reusable session key',
  'one-time-keys': 'One-time connection keys',
  'approved-only': 'Approved clients only',
};
const MODE_LABELS = { profiles: 'Approved profiles only', options: 'Approved options' };

// Display names come from the OS; never pass terminal control sequences through.
export function clean(value) {
  return String(value).replace(/\p{Cc}/gu, '');
}

export function table(headers, rows) {
  const cells = [headers, ...rows].map((row) => row.map(clean));
  const widths = headers.map((_, column) => Math.max(...cells.map((row) => row[column].length)));
  return cells
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]))
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

export function pairs(rows) {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${clean(value)}`).join('\n');
}

export const mbps = (kbps) => `${Number((kbps / 1000).toFixed(3))} Mbit/s`;
export const size = ({ width, height }) => `${width}×${height}`;
export const accessLabel = (value) => ACCESS_LABELS[value];
export const connectionModeLabel = (value) => CONNECTION_MODE_LABELS[value];
export const modeLabel = (mode) => MODE_LABELS[mode];

export function profileName(policy, id) {
  return id === 'auto'
    ? 'Automatic'
    : clean(policy.profiles.find((profile) => profile.id === id)?.name ?? id);
}

export const displayLabel = (display) => `display ${display.number} (${clean(display.name)})`;

export function sharingState(policy, display) {
  if (!display.persistent) return 'unavailable';
  return policy.displaySharing?.[display.id] === true ? 'shared' : 'private';
}

export function formatDisplays(displays, policy) {
  if (!displays.length) return 'No displays found.';
  const rows = displays.map((display) => [
    display.number,
    display.name,
    size(display),
    `${display.x},${display.y}`,
    display.primary ? 'yes' : '',
    sharingState(policy, display),
    Object.hasOwn(policy.displayDefaults, display.id)
      ? profileName(policy, policy.displayDefaults[display.id])
      : 'host default',
  ]);
  return [
    table(['#', 'Name', 'Size', 'Position', 'Primary', 'Sharing', 'Default profile'], rows),
    `Host default profile: ${profileName(policy, policy.defaultProfileId)} · Desktop audio: ${policy.allowAudio ? 'on' : 'off'}`,
  ].join('\n');
}

export const formatAccess = (access) =>
  `Keyboard and mouse for new connections: ${accessLabel(access.defaultControl)}`;
export const formatConnectionMode = (access) =>
  `Ordinary connections: ${connectionModeLabel(access.connectionMode)}`;
export const formatMaxSessions = (access) =>
  `Connected devices at the same time: up to ${access.maxSessions}`;

// TLS settings display. Never shown: certificatePath, keyPath, pfxPath, pfxPassphrase — a
// path or a passphrase never appears in CLI output, matching the rule the trust-status HTTP
// endpoint (http-app.mjs) already applies to the same underlying settings.
const TLS_MODE_LABELS = {
  auto: 'Automatic',
  provided: 'Your own certificate',
  off: 'Off (plaintext only)',
};
export const tlsModeLabel = (mode) => TLS_MODE_LABELS[mode];
export const tlsCredentialLabel = (settings) =>
  settings.pfxPath
    ? 'PFX file'
    : settings.certificatePath && settings.keyPath
      ? 'certificate and key'
      : 'none';
// `settings.invalid` (set by readTlsSettingsStatus, load-settings.mjs) means the on-disk
// file could not be read as real TLS settings; report that distinctly, never as a mode.
export const tlsSummary = (settings) =>
  settings.invalid
    ? { invalid: settings.invalid }
    : { mode: settings.mode, port: settings.port, credential: tlsCredentialLabel(settings) };
export const formatTlsMode = (settings) => `TLS mode: ${tlsModeLabel(settings.mode)}`;
export const formatTlsPort = (settings) => `TLS port: ${settings.port}`;
export const formatTlsCredential = (settings) =>
  `TLS mode: ${tlsModeLabel(settings.mode)}\nCertificate: ${tlsCredentialLabel(settings)}`;

function formatExpiry(anchor) {
  const { validTo, expired, needsRenewal } = renewalStatus(anchor);
  const iso = validTo.toISOString();
  if (expired) return `${iso} (expired)`;
  if (needsRenewal) return `${iso} (renewal due soon)`;
  return iso;
}

// Whether the on-disk TLS settings look like they differ from what the running process
// actually loaded. There is no way to read back exactly what main.mjs loaded at startup
// without invasive plumbing (loadTlsSettings runs once, at startup, and its result is not
// kept anywhere a CLI command can reach), so this is a heuristic over mode/port/strategy:
// it can say "no drift" when the settings changed in a way that keeps mode/port/strategy
// the same (e.g. swapping which certificate file `provided` mode points at), and it can
// say "drift" when TLS is merely failing for an unrelated reason (e.g. a missing mkcert
// binary) rather than because the settings changed. Documented in task-13-report.md.
function tlsDrift(disk, { report, status }) {
  if (disk.mode === 'off') return status.active;
  if (!status.active) return true;
  if (disk.port !== status.port) return true;
  return disk.mode === 'provided' ? report.strategy !== 'provided' : report.strategy === 'provided';
}

// The "Active"/"Strategy"/"Fingerprint"/"Certificate expires" (or "Not serving TLS") block,
// shared between a normal report and an invalid-settings-file report — the running listener
// is described the same way in both cases; only the settings summary above it, and whether
// a drift note makes sense, differs.
function liveStatusLines({ report, status }) {
  const lines = [`Active: ${status.active ? `yes, on port ${status.port}` : 'no'}`];
  if (report.active) {
    lines.push(`Strategy: ${report.strategy}`);
    lines.push(`Fingerprint: ${report.fingerprint}`);
    lines.push(`Certificate expires: ${formatExpiry(report.anchor)}`);
  } else if (report.failureReason) {
    lines.push(`Not serving TLS: ${report.failureReason}`);
  }
  return lines;
}

// `live` is `{ report, status }` from the running TLS listener, or omitted when offline.
// `disk.invalid` (readTlsSettingsStatus, load-settings.mjs) means the on-disk file could
// not be read as real settings — reported as its own distinct state, never as "TLS mode:
// Off", which would read as a deliberate, healthy configuration instead of a broken one.
export function formatTlsStatus(disk, live) {
  if (disk.invalid) {
    const lines = [`TLS settings file is invalid: ${disk.invalid}`];
    if (live) {
      lines.push(...liveStatusLines(live));
      lines.push(
        'Fix the settings file and restart the server to apply a corrected configuration.',
      );
    } else {
      lines.push(
        'The server is not running; fix or delete the file (it will use the automatic defaults until then).',
      );
    }
    return lines.join('\n');
  }
  const lines = [
    formatTlsMode(disk),
    formatTlsPort(disk),
    `Certificate: ${tlsCredentialLabel(disk)}`,
  ];
  if (!live) {
    lines.push('The server is not running; changes take effect the next time it starts.');
    return lines.join('\n');
  }
  lines.push(...liveStatusLines(live));
  if (tlsDrift(disk, live))
    lines.push(
      'The saved settings may differ from what is currently running; restart the server to apply any changes.',
    );
  return lines.join('\n');
}

const bitrateLabel = (profile) =>
  profile.bitrateMode === 'vbr'
    ? `up to ${mbps(profile.bitrateKbps)} (VBR, ${profile.quality})`
    : mbps(profile.bitrateKbps);

// The target frame rate, then the rate control mode and, for VBR, its quality.
const targetLabel = (stream) => {
  if (!stream.targetFps) return 'unknown';
  const fps = `${stream.targetFps} fps`;
  if (stream.bitrateMode === 'vbr') return `${fps}, VBR, ${stream.quality}`;
  return stream.bitrateMode === 'cbr' ? `${fps}, CBR` : fps;
};

export function formatProfiles(profiles, policy) {
  const rows = profiles.map((profile, index) => [
    index + 1,
    profile.id,
    profile.name,
    size(profile),
    profile.fps,
    bitrateLabel(profile),
    profile.enabled ? 'yes' : 'no',
    profile.description,
  ]);
  return [
    table(['#', 'ID', 'Name', 'Size', 'FPS', 'Bitrate', 'Available', 'Description'], rows),
    `Host default profile: ${profileName(policy, policy.defaultProfileId)}`,
  ].join('\n');
}

export function formatOptions(policy) {
  const { resolutions, frameRates, bitratesKbps } = policy.allowedOptions;
  const megabits = bitratesKbps.map((kbps) => Number((kbps / 1000).toFixed(3)));
  return [
    `Client customization: ${modeLabel(policy.clientMode)}`,
    `Output sizes: ${resolutions.map(size).join(', ')}`,
    `Frame rates: ${frameRates.join(', ')} fps`,
    `Video bitrates: ${megabits.join(', ')} Mbit/s`,
  ].join('\n');
}

// Enabled codecs first, in saved order, then the remaining known codecs (disabled, no order).
export function codecRows(policy, hostCodecs) {
  const order = policy.videoCodecs;
  const ids = [...order, ...VIDEO_CODECS.filter((id) => !order.includes(id))];
  return ids.map((id) => {
    const index = order.indexOf(id);
    return {
      id,
      label: CODEC_LABELS[id],
      enabled: index !== -1,
      order: index === -1 ? null : index + 1,
      supported: hostCodecs.includes(id),
    };
  });
}

export function formatCodecs(policy, hostCodecs) {
  const rows = codecRows(policy, hostCodecs).map((row) => [
    row.order ?? '',
    row.label,
    row.enabled ? 'yes' : 'no',
    row.supported ? 'supported' : 'not supported',
  ]);
  return [
    table(['#', 'Codec', 'Enabled', 'This GPU'], rows),
    'Devices use the first enabled codec their browser can decode in hardware; H.264 is always the fallback.',
  ].join('\n');
}

export function optionLabel(kind, value) {
  if (kind === 'size') return `output size ${size(value)}`;
  return kind === 'framerate' ? `${value} fps` : mbps(value);
}

// The console prompt's summary, for example "2 devices · #1 has control".
export function promptState(status, numbers) {
  numbers.prune(new Set(status.sessions.map((row) => row.id)));
  // Number every device in list order so the numbers match what sessions shows.
  for (const row of status.sessions) numbers.number(row.id);
  const count = status.sessions.length;
  if (!count) return 'no devices';
  const holder = status.sessions.find((row) => row.control === 'Granted');
  const devices = `${count} device${count === 1 ? '' : 's'}`;
  return holder ? `${devices} · #${numbers.number(holder.id)} has control` : devices;
}

// Rows come from runtime.status(); row.id is a bearer credential and is never printed.
export function formatSessions(status, numbers) {
  numbers.prune(new Set(status.sessions.map((row) => row.id)));
  if (!status.sessions.length) return 'No connected devices.';
  return status.sessions
    .map((row) => {
      const control = row.control === 'Granted' ? 'control granted' : 'view only';
      const header = `#${numbers.number(row.id)}  ${clean(row.device)} · ${clean(row.address)} · ${row.health} · audio ${row.audio ? 'on' : 'off'} · ${control}`;
      if (!row.streams.length) return `${header}\n    Waiting for a display stream.`;
      const streams = table(
        ['Stream', 'Display', 'Size', 'Target', 'Profile', 'Codec', 'Shared'],
        row.streams.map((stream) => [
          stream.id,
          stream.name,
          stream.width && stream.height ? size(stream) : 'pending',
          targetLabel(stream),
          stream.profile,
          CODEC_LABELS[stream.codec] ?? '',
          stream.viewers > 1 ? `×${stream.viewers}` : '',
        ]),
      );
      return `${header}\n${streams
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n')}`;
    })
    .join('\n');
}
