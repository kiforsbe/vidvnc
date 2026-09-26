import { commands, findCommand } from './commands.mjs';
import { MAX_SESSIONS_LIMIT } from '../access-settings.mjs';
import { BITRATE_MODES, QUALITY_LEVELS } from '../rate-control.mjs';
import { VIDEO_CODECS } from '../video-codecs.mjs';
import { ENCODER_BACKEND_CHOICES } from '../encoder-backends.mjs';

const ON_OFF = ['on', 'off'];
// Fixed choices for value flags; other value flags take free text and complete nothing.
const FLAG_VALUES = { 'bitrate-mode': BITRATE_MODES, quality: QUALITY_LEVELS };
const OPTION_KINDS = ['size', 'framerate', 'bitrate'];

const available = (mode) =>
  commands.filter((command) => command.where === 'both' || command.where === mode);
const firstWords = (mode) =>
  [...new Set(available(mode).map((command) => command.name.split(' ')[0]))].sort();
const secondWords = (mode, first) =>
  available(mode)
    .filter((command) => command.name.startsWith(`${first} `))
    .map((command) => command.name.split(' ')[1])
    .sort();

const displays = async (context) =>
  (await context.displays()).map((display) => String(display.number));
const profiles = (context) => context.policy().profiles.map((profile) => profile.id);
const rows = (context) => {
  const { sessions } = context.sessions.status();
  for (const row of sessions) context.sessions.numbers.number(row.id);
  return sessions;
};
const streams = (context) => rows(context).flatMap((row) => row.streams.map((stream) => stream.id));
// Console numbers only; session IDs are bearer credentials.
const devices = (context) => [
  ...rows(context).map((row) => `#${context.sessions.numbers.number(row.id)}`),
  ...streams(context),
];

function allowedValues(context, kind) {
  const { resolutions, frameRates, bitratesKbps } = context.policy().allowedOptions;
  if (kind === 'size') return resolutions.map(({ width, height }) => `${width}x${height}`);
  return (kind === 'framerate' ? frameRates : bitratesKbps).map(String);
}

// Candidates for each positional argument, given the arguments before it.
const profile = [profiles];
const ARGUMENTS = {
  help: [
    (context) => firstWords(context.mode),
    (context, [first]) => secondWords(context.mode, first),
  ],
  share: [displays, () => ON_OFF],
  'display-default': [displays, (context) => [...profiles(context), 'host']],
  'default-profile': [(context) => ['auto', ...profiles(context)]],
  audio: [() => ON_OFF],
  codecs: [() => ['set'], () => VIDEO_CODECS],
  'encoder-backend': [() => [...ENCODER_BACKEND_CHOICES]],
  access: [() => ['approval', 'available']],
  'remote-access': [() => ON_OFF],
  'public-hosts': [() => ['clear']],
  'media-port': [() => ['auto', '4384']],
  'media-ports': [() => ['auto', '40000-40049']],
  'public-port': [() => ['same', '443']],
  'connection-mode': [() => ['session-key', 'one-time-keys', 'approved-only']],
  'code-alphabet': [() => ['letters-digits', 'letters']],
  'local-session-networks': [() => ['auto']],
  'max-devices': [
    () => Array.from({ length: MAX_SESSIONS_LIMIT }, (_, index) => String(index + 1)),
  ],
  'profile edit': profile,
  'profile duplicate': profile,
  'profile remove': profile,
  'profile enable': profile,
  'profile disable': profile,
  'profile move': [profiles, () => ['up', 'down']],
  'client-mode': [() => ['profiles', 'options']],
  'options add': [() => OPTION_KINDS],
  'options remove': [() => OPTION_KINDS, (context, [kind]) => allowedValues(context, kind)],
  grant: [devices],
  revoke: [devices],
  disconnect: [devices],
  stop: [streams],
};

async function candidates(context, words, fragment) {
  if (!words.length) return firstWords(context.mode);
  if (words.length === 1 && commands.some((command) => command.name.startsWith(`${words[0]} `)))
    return secondWords(context.mode, words[0]);
  const command = findCommand(words);
  if (!command || (command.where !== 'both' && command.where !== context.mode)) return [];
  const flags = { ...command.flags, ...(command.mayDisconnect ? { yes: 'boolean' } : {}) };
  const given = words.slice(command.name.split(' ').length);
  const positionals = [];
  for (let index = 0; index < given.length; index++) {
    const name = given[index].startsWith('--') ? given[index].slice(2) : null;
    if (name === null) positionals.push(given[index]);
    else if (flags[name] === 'value' && index === given.length - 1)
      return FLAG_VALUES[name] ?? []; // its value is next
    else if (flags[name] === 'value') index++;
  }
  if (fragment.startsWith('-'))
    return Object.keys(flags)
      .filter((name) => !given.includes(`--${name}`))
      .map((name) => `--${name}`);
  const next = ARGUMENTS[command.name]?.[positionals.length];
  return next ? next(context, positionals) : [];
}

// readline completer result: [matches, the fragment they replace]. A single match gets a
// trailing space so the next argument can be typed straight away.
export async function complete(context, line) {
  if ((line.match(/"/g) ?? []).length % 2) return [[], line];
  const words = line.split(/\s+/);
  const fragment = words.pop();
  const matches = (await candidates(context, words.filter(Boolean), fragment)).filter((word) =>
    word.startsWith(fragment),
  );
  return [matches.length === 1 ? [`${matches[0]} `] : matches, fragment];
}
