import { capitalize, expectArguments } from '../arguments.mjs';
import { formatSessions } from '../format.mjs';
import { resolveSession } from '../resolve.mjs';

const findSession = (context, selector) =>
  resolveSession(context.sessions.status().sessions, context.sessions.numbers, selector);
const deviceLabel = (context, row) => `device #${context.sessions.numbers.number(row.id)}`;

export const sessionCommands = [
  {
    name: 'sessions',
    usage: 'sessions',
    summary: 'List connected devices and their display streams.',
    where: 'live',
    run: (context, { positionals }) => {
      expectArguments(positionals, 0);
      return { text: formatSessions(context.sessions.status(), context.sessions.numbers) };
    },
  },
  {
    name: 'grant',
    usage: 'grant <session>',
    summary: 'Give keyboard and mouse control to a device (#number or one of its stream IDs).',
    where: 'live',
    run: async (context, { positionals }) => {
      expectArguments(positionals, 1);
      const row = findSession(context, positionals[0]);
      const label = deviceLabel(context, row);
      if (!row.selectedStreamId)
        throw new Error(`${capitalize(label)} has not selected a display stream yet.`);
      await context.sessions.grant(row.id);
      return { text: `Granted control to ${label}.` };
    },
  },
  {
    name: 'revoke',
    usage: 'revoke [session]',
    summary: 'Take back keyboard and mouse control, from anyone or from one device.',
    where: 'live',
    run: async (context, { positionals }) => {
      expectArguments(positionals, 0, 1);
      if (!positionals.length) {
        await context.sessions.revoke();
        return { text: 'Control revoked.' };
      }
      const row = findSession(context, positionals[0]);
      await context.sessions.revoke(row.id);
      return { text: `Revoked control from ${deviceLabel(context, row)}.` };
    },
  },
  {
    name: 'stop',
    usage: 'stop <stream-id>',
    summary: 'Stop one display stream without disconnecting the device.',
    where: 'live',
    run: async (context, { positionals }) => {
      expectArguments(positionals, 1);
      const [streamId] = positionals;
      const row = context.sessions
        .status()
        .sessions.find((session) => session.streams.some((stream) => stream.id === streamId));
      if (!row) throw new Error(`No active stream ${streamId}. Use sessions to list them.`);
      await context.sessions.stopStream(row.id, streamId);
      return { text: 'Stream stopped.' };
    },
  },
  {
    name: 'disconnect',
    usage: 'disconnect <session>',
    summary: 'Disconnect a device (#number or one of its stream IDs).',
    where: 'live',
    run: async (context, { positionals }) => {
      expectArguments(positionals, 1);
      const row = findSession(context, positionals[0]);
      const label = deviceLabel(context, row);
      await context.sessions.disconnect(row.id);
      return { text: `Disconnected ${label}.` };
    },
  },
];
