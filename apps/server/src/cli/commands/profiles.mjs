import { UsageError } from '../usage-error.mjs';
import { expectArguments, outcome, parseChoice, parseSize, parseWhole } from '../arguments.mjs';
import { BITRATE_MODES, QUALITY_LEVELS } from '../../rate-control.mjs';
import { ASPECTS } from '../../stream-policy.mjs';
import {
  clean,
  formatAccess,
  formatConnectionMode,
  formatMaxSessions,
  formatOptions,
  formatProfiles,
  modeLabel,
  optionLabel,
} from '../format.mjs';
import { resolveProfile } from '../resolve.mjs';
import * as edits from '../policy-edits.mjs';

const VALUE_FLAGS = {
  description: 'value',
  size: 'value',
  height: 'value',
  width: 'value',
  scale: 'value',
  aspect: 'value',
  fps: 'value',
  bitrate: 'value',
  'bitrate-mode': 'value',
  quality: 'value',
};
const confirmation = (flags) => ({ yes: flags.yes === true });

function profileValues(flags) {
  const values = {};
  if (flags.name !== undefined) values.name = flags.name;
  if (flags.description !== undefined) values.description = flags.description;
  // One way to size the stream: a height or a width that follows the screen's shape, a
  // percentage of the screen, or a fixed box.
  const sizings = ['size', 'height', 'width', 'scale'].filter((key) => flags[key] !== undefined);
  if (sizings.length > 1)
    throw new UsageError('Use only one of --size, --height, --width and --scale.');
  if (flags.aspect !== undefined && flags.size === undefined)
    throw new UsageError('--aspect goes with --size.');
  if (flags.size !== undefined)
    Object.assign(values, parseSize(flags.size), {
      sizing: 'fixed',
      aspect: flags.aspect === undefined ? 'keep' : parseChoice(flags.aspect, ASPECTS, 'Aspect'),
    });
  if (flags.height !== undefined)
    Object.assign(values, { sizing: 'height', height: parseEven(flags.height, 'Height') });
  if (flags.width !== undefined)
    Object.assign(values, { sizing: 'width', width: parseEven(flags.width, 'Width') });
  if (flags.scale !== undefined)
    Object.assign(values, {
      sizing: 'scale',
      scalePercent: parseWhole(String(flags.scale).replace(/%$/, ''), 'Scale'),
    });
  if (flags.fps !== undefined) values.fps = parseWhole(flags.fps, 'Frame rate');
  if (flags.bitrate !== undefined) values.bitrateKbps = parseWhole(flags.bitrate, 'Bitrate');
  if (flags['bitrate-mode'] !== undefined)
    values.bitrateMode = parseChoice(flags['bitrate-mode'], BITRATE_MODES, 'Bitrate mode');
  if (flags.quality !== undefined)
    values.quality = parseChoice(flags.quality, QUALITY_LEVELS, 'Quality');
  if (flags.enabled && flags.disabled) throw new UsageError('Use either --enabled or --disabled.');
  if (flags.enabled) values.enabled = true;
  if (flags.disabled) values.enabled = false;
  return values;
}

function parseEven(value, label) {
  const number = parseWhole(value, label);
  if (number % 2) throw new Error(`${label} must be even`);
  return number;
}

function parseOption(kind, value) {
  if (kind === 'size') return parseSize(value);
  if (kind === 'framerate') return parseWhole(value, 'Frame rate');
  if (kind === 'bitrate') return parseWhole(value, 'Bitrate');
  throw new UsageError('Choose size, framerate or bitrate.');
}

const toggleCommands = ['enable', 'disable'].map((action) => ({
  name: `profile ${action}`,
  usage: `profile ${action} <profile>`,
  summary:
    action === 'enable' ? 'Make a profile available to clients.' : 'Hide a profile from clients.',
  where: 'both',
  mayDisconnect: true,
  run: async (context, { positionals, flags }) => {
    expectArguments(positionals, 1);
    const profile = resolveProfile(context.policy().profiles, positionals[0]);
    const name = clean(profile.name);
    const enabled = action === 'enable';
    const result = await context.updatePolicy(
      enabled ? `Make profile "${name}" available` : `Hide profile "${name}"`,
      (policy) => edits.setProfileEnabled(policy, profile.id, enabled),
      confirmation(flags),
    );
    return outcome(result, `Profile "${name}" is now ${enabled ? 'available' : 'hidden'}.`);
  },
}));

const optionCommands = ['add', 'remove'].map((action) => ({
  name: `options ${action}`,
  usage: `options ${action} size WxH | framerate N | bitrate KBPS`,
  summary:
    action === 'add'
      ? 'Allow another output size, frame rate or bitrate.'
      : 'Remove an allowed output size, frame rate or bitrate.',
  where: 'both',
  mayDisconnect: true,
  run: async (context, { positionals, flags }) => {
    expectArguments(positionals, 2);
    const [kind, text] = positionals;
    const value = parseOption(kind, text);
    const label = optionLabel(kind, value);
    const result = await context.updatePolicy(
      `${action === 'add' ? 'Allow' : 'Remove'} ${label}`,
      (policy) =>
        action === 'add'
          ? edits.addAllowedOption(policy, kind, value)
          : edits.removeAllowedOption(policy, kind, value),
      confirmation(flags),
    );
    return outcome(result, `${action === 'add' ? 'Allowed' : 'Removed'} ${label}.`);
  },
}));

export const profileCommands = [
  {
    name: 'profiles',
    usage: 'profiles',
    summary: 'List streaming profiles in the order clients see them.',
    where: 'both',
    json: true,
    run: async (context, { positionals }) => {
      expectArguments(positionals, 0);
      const profiles = await context.orderedProfiles();
      return { text: formatProfiles(profiles, context.policy()), data: profiles };
    },
  },
  {
    name: 'profile add',
    usage:
      'profile add <name> [--height N | --width N | --scale PERCENT | --size WxH [--aspect keep|fit|stretch]] [--fps N] [--bitrate KBPS] [--bitrate-mode cbr|vbr] [--quality efficient|balanced|high] [--description TEXT] [--disabled]',
    summary:
      "Create a profile. Defaults: 1080 pixels high in the shared screen's shape, 30 fps, 4000 kbit/s, cbr, balanced quality, available. --height and --width fix one side and follow the screen's shape; --scale is a percentage of the screen's size (10 to 400); --size is a fixed box, which --aspect keep shrinks to the screen's shape (the default), fit fills with bars and stretch fills. A VBR profile treats the bitrate as a sustained cap.",
    where: 'both',
    mayDisconnect: true,
    flags: { ...VALUE_FLAGS, disabled: 'boolean' },
    run: async (context, { positionals, flags }) => {
      expectArguments(positionals, 1);
      const values = profileValues(flags);
      let created;
      const result = await context.updatePolicy(
        `Add profile "${clean(positionals[0].trim())}"`,
        (policy) => {
          const added = edits.addProfile(policy, { ...values, name: positionals[0] });
          created = added.profile;
          return added.policy;
        },
        confirmation(flags),
      );
      return outcome(
        result,
        `Added profile "${clean(created?.name ?? '')}" with ID ${created?.id}.`,
      );
    },
  },
  {
    name: 'profile edit',
    usage:
      'profile edit <profile> [--name TEXT] [--description TEXT] [--height N | --width N | --scale PERCENT | --size WxH [--aspect keep|fit|stretch]] [--fps N] [--bitrate KBPS] [--bitrate-mode cbr|vbr] [--quality efficient|balanced|high] [--enabled|--disabled]',
    summary: 'Change a profile.',
    where: 'both',
    mayDisconnect: true,
    flags: { ...VALUE_FLAGS, name: 'value', enabled: 'boolean', disabled: 'boolean' },
    run: async (context, { positionals, flags }) => {
      expectArguments(positionals, 1);
      const changes = profileValues(flags);
      if (!Object.keys(changes).length)
        throw new UsageError('Give at least one change, for example --fps 60.');
      const profile = resolveProfile(context.policy().profiles, positionals[0]);
      const name = clean(profile.name);
      const result = await context.updatePolicy(
        `Change profile "${name}"`,
        (policy) => edits.editProfile(policy, profile.id, changes),
        confirmation(flags),
      );
      return outcome(result, `Updated profile "${clean(changes.name?.trim() ?? profile.name)}".`);
    },
  },
  {
    name: 'profile duplicate',
    usage: 'profile duplicate <profile>',
    summary: 'Copy a profile as "Copy of <name>".',
    where: 'both',
    mayDisconnect: true,
    run: async (context, { positionals, flags }) => {
      expectArguments(positionals, 1);
      const profile = resolveProfile(context.policy().profiles, positionals[0]);
      const name = clean(profile.name);
      let created;
      const result = await context.updatePolicy(
        `Duplicate profile "${name}"`,
        (policy) => {
          const copy = edits.duplicateProfile(policy, profile.id);
          created = copy.profile;
          return copy.policy;
        },
        confirmation(flags),
      );
      return outcome(
        result,
        `Added profile "${clean(created?.name ?? '')}" with ID ${created?.id}.`,
      );
    },
  },
  {
    name: 'profile remove',
    usage: 'profile remove <profile>',
    summary: 'Delete a profile.',
    where: 'both',
    mayDisconnect: true,
    run: async (context, { positionals, flags }) => {
      expectArguments(positionals, 1);
      const profile = resolveProfile(context.policy().profiles, positionals[0]);
      const name = clean(profile.name);
      const result = await context.updatePolicy(
        `Remove profile "${name}"`,
        (policy) => edits.removeProfile(policy, profile.id),
        confirmation(flags),
      );
      return outcome(result, `Removed profile "${name}".`);
    },
  },
  ...toggleCommands,
  {
    name: 'profile move',
    usage: 'profile move <profile> up|down|<position>',
    summary: 'Change the order clients see profiles in. Never disconnects devices.',
    where: 'both',
    run: async (context, { positionals }) => {
      expectArguments(positionals, 2);
      const profiles = await context.orderedProfiles();
      const profile = resolveProfile(profiles, positionals[0]);
      const from = profiles.indexOf(profile);
      const [, direction] = positionals;
      let target;
      if (direction === 'up') target = from - 1;
      else if (direction === 'down') target = from + 1;
      else if (/^\d{1,2}$/.test(direction)) target = Number(direction) - 1;
      else throw new UsageError('Use up, down or a position number.');
      if (target < 0 || target >= profiles.length)
        throw new Error(`Position must be from 1 to ${profiles.length}.`);
      const ids = profiles.map((row) => row.id);
      ids.splice(from, 1);
      ids.splice(target, 0, profile.id);
      await context.saveProfileOrder(ids);
      return { text: `Moved "${clean(profile.name)}" to position ${target + 1}.` };
    },
  },
  {
    name: 'client-mode',
    usage: 'client-mode profiles|options',
    summary: 'Let clients choose approved profiles only, or approved options.',
    where: 'both',
    mayDisconnect: true,
    run: async (context, { positionals, flags }) => {
      expectArguments(positionals, 1);
      const [mode] = positionals;
      if (!['profiles', 'options'].includes(mode)) throw new UsageError('Use profiles or options.');
      const label = modeLabel(mode);
      const result = await context.updatePolicy(
        `Set client customization to ${label}`,
        (policy) => edits.setClientMode(policy, mode),
        confirmation(flags),
      );
      return outcome(result, `Client customization is now ${label}.`);
    },
  },
  {
    name: 'options',
    usage: 'options',
    summary: 'Show client customization and the allowed options.',
    where: 'both',
    json: true,
    run: async (context, { positionals }) => {
      expectArguments(positionals, 0);
      const policy = context.policy();
      return {
        text: formatOptions(policy),
        data: { clientMode: policy.clientMode, allowedOptions: policy.allowedOptions },
      };
    },
  },
  ...optionCommands,
  {
    name: 'show',
    usage: 'show',
    summary: 'Show all saved settings.',
    where: 'offline',
    json: true,
    run: async (context, { positionals }) => {
      expectArguments(positionals, 0);
      const policy = context.policy();
      const profiles = await context.orderedProfiles();
      const access = context.access();
      return {
        text: [
          formatProfiles(profiles, policy),
          formatOptions(policy),
          `${formatAccess(access)}\n${formatConnectionMode(access)}\n${formatMaxSessions(access)}\nDesktop audio: ${policy.allowAudio ? 'on' : 'off'}`,
        ].join('\n\n'),
        data: { policy, access, profileOrder: profiles.map((profile) => profile.id) },
      };
    },
  },
];
