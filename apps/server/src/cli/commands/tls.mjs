// TLS configuration commands: one concern per command, matching connection-mode/max-devices
// in settings.mjs rather than a subcommand group. `tls-mode`, `tls-port`, `tls-cert` and
// `tls-pfx` write tls-settings.json directly and are offline-only: the running server reads
// that file once at startup (load-settings.mjs) and never hot-reloads it, so allowing these
// while live would silently do nothing until a restart — worse than refusing, which is why
// they go through the same `where: 'offline'` refusal every other settings write uses. `tls`
// (status, no set form) is the one command that works both live and offline, since showing
// status needs no write.
import { UsageError } from '../usage-error.mjs';
import { expectArguments } from '../arguments.mjs';
import {
  formatTlsCredential,
  formatTlsMode,
  formatTlsPort,
  formatTlsStatus,
  tlsSummary,
} from '../format.mjs';

const TLS_MODES = ['auto', 'provided', 'off'];

// Switching to `provided` leaves whatever certificate settings are already saved (tls-cert
// or tls-pfx sets them separately); switching away from it clears all three credential
// fields, since validateTlsSettings requires them to be null outside `provided` mode — the
// same reason tls-cert clears pfx* and tls-pfx clears certificate*/key* below.
const modeChanges = (mode) =>
  mode === 'provided'
    ? { mode }
    : { mode, certificatePath: null, keyPath: null, pfxPath: null, pfxPassphrase: null };

export const tlsCommands = [
  {
    name: 'tls-mode',
    usage: 'tls-mode [auto|provided|off]',
    summary: 'Show or set how TLS certificates are provisioned.',
    where: 'offline',
    json: true,
    run: async (context, { positionals }) => {
      expectArguments(positionals, 0, 1);
      if (positionals.length && !TLS_MODES.includes(positionals[0]))
        throw new UsageError('Use auto, provided, or off.');
      const settings = positionals.length
        ? await context.saveTls(modeChanges(positionals[0]))
        : await context.tlsSettings();
      return { text: formatTlsMode(settings), data: tlsSummary(settings) };
    },
  },
  {
    name: 'tls-port',
    usage: 'tls-port [1-65535]',
    summary: 'Show or set the port the TLS listener uses.',
    where: 'offline',
    json: true,
    run: async (context, { positionals }) => {
      expectArguments(positionals, 0, 1);
      const value = Number(positionals[0]);
      if (positionals.length && (!/^\d+$/.test(positionals[0]) || value < 1 || value > 65535))
        throw new UsageError('Use a number from 1 to 65535.');
      const settings = positionals.length
        ? await context.saveTls({ port: value })
        : await context.tlsSettings();
      return { text: formatTlsPort(settings), data: tlsSummary(settings) };
    },
  },
  {
    name: 'tls-cert',
    usage: 'tls-cert <cert-path> <key-path>',
    summary: 'Use a PEM certificate and key for provided-mode TLS.',
    where: 'offline',
    json: true,
    run: async (context, { positionals }) => {
      expectArguments(positionals, 2);
      const [certificatePath, keyPath] = positionals;
      const settings = await context.saveTls({
        mode: 'provided',
        certificatePath,
        keyPath,
        pfxPath: null,
        pfxPassphrase: null,
      });
      return { text: formatTlsCredential(settings), data: tlsSummary(settings) };
    },
  },
  {
    name: 'tls-pfx',
    usage: 'tls-pfx <pfx-path> [passphrase]',
    summary: 'Use a PFX file for provided-mode TLS.',
    where: 'offline',
    json: true,
    run: async (context, { positionals }) => {
      expectArguments(positionals, 1, 2);
      const [pfxPath, passphrase] = positionals;
      const settings = await context.saveTls({
        mode: 'provided',
        pfxPath,
        pfxPassphrase: passphrase ?? null,
        certificatePath: null,
        keyPath: null,
      });
      return { text: formatTlsCredential(settings), data: tlsSummary(settings) };
    },
  },
  {
    name: 'tls',
    usage: 'tls',
    summary: 'Show TLS status: mode, port, active strategy, expiry and fingerprint.',
    where: 'both',
    json: true,
    run: async (context, { positionals }) => {
      expectArguments(positionals, 0);
      const disk = await context.tlsSettings();
      if (context.mode === 'offline')
        return { text: formatTlsStatus(disk), data: tlsSummary(disk) };
      const report = context.tlsListener.report();
      const status = context.tlsListener.status();
      return {
        text: formatTlsStatus(disk, { report, status }),
        data: {
          ...tlsSummary(disk),
          active: report.active,
          strategy: report.strategy,
          fingerprint: report.fingerprint,
          listening: status.active,
          listeningPort: status.port,
        },
      };
    },
  },
];
