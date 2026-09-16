import { CODEC_LABELS, VIDEO_CODECS } from '../video-codecs.mjs';

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

export function formatProfiles(profiles, policy) {
  const rows = profiles.map((profile, index) => [
    index + 1,
    profile.id,
    profile.name,
    size(profile),
    profile.fps,
    mbps(profile.bitrateKbps),
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
          stream.targetFps ? `${stream.targetFps} fps` : 'unknown',
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
