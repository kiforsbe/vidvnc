import { UsageError } from '../usage-error.mjs';
import { capitalize, expectArguments, onOff, outcome } from '../arguments.mjs';
import {
  clean,
  codecRows,
  displayLabel,
  formatAccess,
  formatCodecs,
  formatConnectionMode,
  formatDisplays,
  formatMaxSessions,
} from '../format.mjs';
import { MAX_SESSIONS_LIMIT } from '../../access-settings.mjs';
import { CODEC_LABELS, VIDEO_CODECS } from '../../video-codecs.mjs';
import { BACKEND_LABELS, ENCODER_BACKEND_CHOICES } from '../../encoder-backends.mjs';
import { resolveDisplay, resolveProfile } from '../resolve.mjs';
import * as edits from '../policy-edits.mjs';

const CODEC_ALIASES = { 'h.264': 'h264', 'h.265': 'h265' };

export const settingsCommands = [
  {
    name: 'displays',
    usage: 'displays',
    summary: 'List displays with sharing and default profiles.',
    where: 'both',
    json: true,
    run: async (context, { positionals }) => {
      expectArguments(positionals, 0);
      const displays = await context.displays();
      const policy = edits.seedDisplaySharing(context.policy(), displays);
      return {
        text: formatDisplays(displays, policy),
        data: displays.map((display) => ({
          ...display,
          shared: display.persistent && policy.displaySharing[display.id] === true,
          defaultProfileId: policy.displayDefaults[display.id] ?? null,
        })),
      };
    },
  },
  {
    name: 'share',
    usage: 'share <display> on|off',
    summary: 'Allow or stop sharing a display.',
    where: 'both',
    mayDisconnect: true,
    run: async (context, { positionals, flags }) => {
      expectArguments(positionals, 2);
      const shared = onOff(positionals[1]);
      const display = resolveDisplay(await context.displays(), positionals[0]);
      const label = displayLabel(display);
      const result = await context.updatePolicy(
        `${shared ? 'Share' : 'Stop sharing'} ${label}`,
        async (policy) => {
          const displays = await context.displays();
          const current = displays.find((row) => row.id === display.id);
          if (!current) throw new Error(`${capitalize(label)} is no longer connected.`);
          return edits.setDisplaySharing(policy, displays, current, shared);
        },
        { yes: flags.yes === true },
      );
      return outcome(result, `${capitalize(label)} is now ${shared ? 'shared' : 'private'}.`);
    },
  },
  {
    name: 'display-default',
    usage: 'display-default <display> <profile>|host',
    summary: "Set a display's default profile, or use the host default.",
    where: 'both',
    mayDisconnect: true,
    run: async (context, { positionals, flags }) => {
      expectArguments(positionals, 2);
      const display = resolveDisplay(await context.displays(), positionals[0]);
      const profile =
        positionals[1].toLowerCase() === 'host'
          ? null
          : resolveProfile(context.policy().profiles, positionals[1]);
      const label = displayLabel(display);
      const choice = profile ? `"${clean(profile.name)}"` : 'the host default';
      const result = await context.updatePolicy(
        `Use ${choice} for ${label}`,
        (policy) => edits.setDisplayDefault(policy, display.id, profile?.id ?? null),
        { yes: flags.yes === true },
      );
      return outcome(result, `${capitalize(label)} now uses ${choice}.`);
    },
  },
  {
    name: 'default-profile',
    usage: 'default-profile auto|<profile>',
    summary: 'Set the host default profile.',
    where: 'both',
    mayDisconnect: true,
    run: async (context, { positionals, flags }) => {
      expectArguments(positionals, 1);
      const profile =
        positionals[0].toLowerCase() === 'auto'
          ? null
          : resolveProfile(context.policy().profiles, positionals[0]);
      const choice = profile ? `"${clean(profile.name)}"` : 'Automatic';
      const result = await context.updatePolicy(
        `Use ${choice} as the host default profile`,
        (policy) => edits.setDefaultProfile(policy, profile?.id ?? 'auto'),
        { yes: flags.yes === true },
      );
      return outcome(result, `The host default profile is now ${choice}.`);
    },
  },
  {
    name: 'audio',
    usage: 'audio on|off',
    summary: 'Allow or block sharing desktop audio.',
    where: 'both',
    mayDisconnect: true,
    run: async (context, { positionals, flags }) => {
      expectArguments(positionals, 1);
      const allowed = onOff(positionals[0]);
      const state = allowed ? 'on' : 'off';
      const result = await context.updatePolicy(
        `Turn desktop audio ${state}`,
        (policy) => edits.setAudio(policy, allowed),
        { yes: flags.yes === true },
      );
      return outcome(result, `Desktop audio is now ${state}.`);
    },
  },
  {
    name: 'codecs',
    usage: 'codecs [set <codec,codec,…>]',
    summary: 'Show or set which video codecs the host offers, and in what order.',
    where: 'both',
    json: true,
    mayDisconnect: true,
    run: async (context, { positionals, flags }) => {
      if (!positionals.length) {
        const hostCodecs = await context.hostCodecs();
        const policy = context.policy();
        return { text: formatCodecs(policy, hostCodecs), data: codecRows(policy, hostCodecs) };
      }
      expectArguments(positionals, 2);
      if (positionals[0] !== 'set') throw new UsageError('Use codecs set <codec,codec,…>.');
      const ids = positionals[1].split(',').map((token) => {
        const id = token.trim().toLowerCase();
        return CODEC_ALIASES[id] ?? id;
      });
      const unknown = ids.find((id) => !VIDEO_CODECS.includes(id));
      if (unknown)
        throw new UsageError(`Unknown codec "${unknown}". Use ${VIDEO_CODECS.join(', ')}.`);
      const labels = ids.map((id) => CODEC_LABELS[id]);
      // Probe before saving: if the GPU/worker is unavailable this throws before the policy
      // is touched, instead of leaving the user unsure whether their change was saved.
      const hostCodecs = await context.hostCodecs();
      const result = await context.updatePolicy(
        `Use video codecs ${labels.join(', ')}`,
        (policy) => edits.setVideoCodecs(policy, ids),
        { yes: flags.yes === true },
      );
      const unsupported = ids
        .filter((id) => !hostCodecs.includes(id))
        .map((id) => `${CODEC_LABELS[id]} is not supported by this GPU and will be skipped.`);
      const message = [`Video codec order is now ${labels.join(', ')}.`, ...unsupported].join('\n');
      const policy = result.applied ? result.policy : context.policy();
      return { ...outcome(result, message), data: codecRows(policy, hostCodecs) };
    },
  },
  {
    name: 'encoder-backend',
    usage: 'encoder-backend [auto|nvenc|qsv|amf|mediafoundation]',
    summary: 'Show or set which GPU encoder the host uses.',
    where: 'both',
    json: true,
    mayDisconnect: true,
    run: async (context, { positionals, flags }) => {
      const describe = (id) => (id === 'auto' ? 'Automatic' : BACKEND_LABELS[id]);
      if (!positionals.length) {
        const current = context.policy().encoderBackend;
        return { text: `Encoder: ${describe(current)}`, data: { encoderBackend: current } };
      }
      expectArguments(positionals, 1);
      const backend = positionals[0].trim().toLowerCase();
      if (!ENCODER_BACKEND_CHOICES.includes(backend))
        throw new UsageError(
          `Unknown encoder "${positionals[0]}". Use ${ENCODER_BACKEND_CHOICES.join(', ')}.`,
        );
      const result = await context.updatePolicy(
        `Use the ${describe(backend)} encoder`,
        (policy) => edits.setEncoderBackend(policy, backend),
        { yes: flags.yes === true },
      );
      // A named backend this machine lacks is not an error: the worker falls back to automatic
      // selection, and a policy file may have arrived from a different machine.
      const message =
        backend === 'auto'
          ? 'The encoder is now chosen automatically.'
          : `Encoder is now ${describe(backend)}. If this machine has no such encoder, one is chosen automatically.`;
      const policy = result.applied ? result.policy : context.policy();
      return { ...outcome(result, message), data: { encoderBackend: policy.encoderBackend } };
    },
  },
  {
    name: 'access',
    usage: 'access [approval|available]',
    summary: 'Show or set default keyboard and mouse access for new connections.',
    where: 'both',
    json: true,
    run: async (context, { positionals }) => {
      expectArguments(positionals, 0, 1);
      if (positionals.length && !['approval', 'available'].includes(positionals[0]))
        throw new UsageError('Use approval or available.');
      const access = positionals.length
        ? await context.saveAccess({ defaultControl: positionals[0] })
        : context.access();
      return { text: formatAccess(access), data: access };
    },
  },
  {
    name: 'connection-mode',
    usage: 'connection-mode [session-key|one-time-keys|approved-only]',
    summary: 'Show or set how ordinary clients may connect.',
    where: 'both',
    json: true,
    run: async (context, { positionals }) => {
      expectArguments(positionals, 0, 1);
      if (
        positionals.length &&
        !['session-key', 'one-time-keys', 'approved-only'].includes(positionals[0])
      )
        throw new UsageError('Use session-key, one-time-keys, or approved-only.');
      const access = positionals.length
        ? await context.saveAccess({ connectionMode: positionals[0] })
        : context.access();
      return { text: formatConnectionMode(access), data: access };
    },
  },
  {
    name: 'max-devices',
    usage: `max-devices [1-${MAX_SESSIONS_LIMIT}]`,
    summary: 'Show or set how many devices can be connected at the same time.',
    where: 'both',
    json: true,
    run: async (context, { positionals }) => {
      expectArguments(positionals, 0, 1);
      const value = Number(positionals[0]);
      if (
        positionals.length &&
        (!/^\d+$/.test(positionals[0]) || value < 1 || value > MAX_SESSIONS_LIMIT)
      )
        throw new UsageError(`Use a number from 1 to ${MAX_SESSIONS_LIMIT}.`);
      const access = positionals.length
        ? await context.saveAccess({ maxSessions: value })
        : context.access();
      return { text: formatMaxSessions(access), data: access };
    },
  },
];
