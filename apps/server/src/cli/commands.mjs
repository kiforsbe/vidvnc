import { tokenize } from './tokenize.mjs';
import { UsageError } from './usage-error.mjs';
import { expectArguments, parseFlags } from './arguments.mjs';
import { pairs } from './format.mjs';
import { settingsCommands } from './commands/settings.mjs';
import { profileCommands } from './commands/profiles.mjs';
import { sessionCommands } from './commands/sessions.mjs';
import { tlsCommands } from './commands/tls.mjs';

const generalCommands = [
  {
    name: 'help',
    usage: 'help [command]',
    summary: 'List commands, or show how to use one.',
    where: 'both',
    run: (context, { positionals }) => ({ text: helpText(context.mode, positionals.join(' ')) }),
  },
  {
    name: 'info',
    usage: 'info',
    summary: 'Show connection details and where settings and logs are stored.',
    where: 'both',
    run: async (context, { positionals }) => {
      expectArguments(positionals, 0);
      return { text: pairs(await context.info()) };
    },
  },
  ...['exit', 'quit'].map((name) => ({
    name,
    usage: name,
    summary: 'Stop sharing and close the server.',
    where: 'live',
    mayDisconnect: true,
    run: (context, { positionals, flags }) => {
      expectArguments(positionals, 0);
      return context.exit({ yes: flags.yes === true });
    },
  })),
];

export const commands = [
  ...generalCommands,
  ...settingsCommands,
  ...tlsCommands,
  ...profileCommands,
  ...sessionCommands,
];

const ONLY = {
  live: 'Available only in the running server console.',
  offline: 'Available only as a config command.',
};

function helpText(mode, topic) {
  const prefix = mode === 'offline' ? 'config ' : '';
  const exact = commands.find((command) => command.name === topic);
  if (exact) {
    const notes = [];
    if (exact.where !== 'both' && exact.where !== mode) notes.push(ONLY[exact.where]);
    if (exact.mayDisconnect && mode === 'live')
      notes.push(
        'Connected devices are disconnected when this applies; add --yes to skip the question.',
      );
    if (exact.json && mode === 'offline') notes.push('Add --json for machine-readable output.');
    const usagePrefix = { offline: 'config ', live: '', both: prefix }[exact.where];
    return [`Usage: ${usagePrefix}${exact.usage}`, exact.summary, ...notes].join('\n');
  }
  const available = commands.filter(
    (command) => command.where === 'both' || command.where === mode,
  );
  const matching = topic
    ? available.filter((command) => command.name.startsWith(`${topic} `))
    : available;
  if (!matching.length) throw new UsageError(`Unknown command "${topic}".`);
  return [
    topic ? `${topic} commands:` : 'Commands:',
    ...matching.map((command) => `  ${prefix}${command.usage}\n      ${command.summary}`),
  ].join('\n');
}

export function findCommand(tokens) {
  const twoWords = tokens.slice(0, 2).join(' ');
  return (
    commands.find((command) => command.name === twoWords) ??
    commands.find((command) => command.name === tokens[0])
  );
}

function helpHint(context, command) {
  const help = context.mode === 'offline' ? 'config help' : 'help';
  return command && command.name !== 'help'
    ? ` Type ${help} ${command.name}.`
    : ` Type ${help} for commands.`;
}

export async function execute(context, tokens) {
  if (!tokens.length) return { text: '', json: false };
  const command = findCommand(tokens);
  try {
    if (!command) throw new UsageError(`Unknown command "${tokens[0]}".`);
    if (command.where === 'live' && context.mode !== 'live')
      throw new UsageError(`${command.name} is only available in the running server console.`);
    if (command.where === 'offline' && context.mode !== 'offline')
      throw new UsageError(`${command.name} is only available as config ${command.name}.`);
    const allowed = { ...command.flags };
    if (command.mayDisconnect) allowed.yes = 'boolean';
    if (command.json && context.mode === 'offline') allowed.json = 'boolean';
    const args = parseFlags(tokens.slice(command.name.split(' ').length), allowed);
    return { ...(await command.run(context, args)), json: args.flags.json === true };
  } catch (error) {
    if (error instanceof UsageError) error.message += helpHint(context, command);
    throw error;
  }
}

export async function executeLine(context, line) {
  let tokens;
  try {
    tokens = tokenize(line);
  } catch (error) {
    if (error instanceof UsageError) error.message += helpHint(context);
    throw error;
  }
  return execute(context, tokens);
}
