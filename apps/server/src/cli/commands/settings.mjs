import { UsageError } from '../usage-error.mjs';
import { capitalize, expectArguments, onOff, outcome } from '../arguments.mjs';
import { clean, displayLabel, formatAccess, formatDisplays } from '../format.mjs';
import { resolveDisplay, resolveProfile } from '../resolve.mjs';
import * as edits from '../policy-edits.mjs';

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
        ? await context.saveAccess(positionals[0])
        : context.access();
      return { text: formatAccess(access), data: access };
    },
  },
];
