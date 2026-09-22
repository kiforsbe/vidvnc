import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { AccessSettings } from '../access-settings.mjs';
import { DisplayInventory } from '../displays.mjs';
import { isAlive, runningInstances } from '../instances.mjs';
import { settingsFiles } from '../paths.mjs';
import { applyProfileOrder, saveProfileOrder } from '../profile-order.mjs';
import { StreamPolicyStore } from '../stream-policy-store.mjs';
import { loadTlsSettings } from '../tls/load-settings.mjs';
import { defaultTlsSettings, validateTlsSettings } from '../tls/tls-settings.mjs';
import { execute } from './commands.mjs';
import { withConflictAdvice } from './conflict-advice.mjs';
import { UsageError } from './usage-error.mjs';

// Matches main.mjs's own rule for the live plaintext port (main.mjs:91-92), so offline
// validation of a new TLS port enforces exactly what a real startup would.
const plaintextPort = () => Number(process.env.VIDVNC_PORT) || 4382;

const RETRY = 'Try again.';

// The Windows app has no console, so "type this command in its console" is wrong
// for it; an unrecognized mode (or a stale record with no mode) gets neutral advice.
const REFUSAL_ADVICE = {
  desktop: 'Change this setting in the VidVNC app instead.',
  cli: 'Type this command in its console instead.',
};
const DEFAULT_REFUSAL_ADVICE = 'Stop it first, or use its console or the VidVNC app.';

async function defaultListDisplays() {
  // Loaded lazily: only display commands need the native worker.
  const { listDisplays } = await import('../native-media.mjs');
  return listDisplays();
}

async function defaultProbeCodecs() {
  // Loaded lazily: only the codecs command needs the native worker.
  const { probe } = await import('../native-media.mjs');
  return probe().codecs ?? ['h264'];
}

export async function createOfflineContext({
  directory,
  logDirectory,
  listDisplays = defaultListDisplays,
  probeCodecs = defaultProbeCodecs,
  alive = isAlive,
}) {
  const files = settingsFiles(directory);
  const store = await StreamPolicyStore.open(files.policy);
  const access = await AccessSettings.open(files.access);
  let displays;
  let codecs;
  const ensureStopped = () => {
    const [running] = runningInstances(files.instances, { alive });
    if (running) {
      const advice = REFUSAL_ADVICE[running.mode] ?? DEFAULT_REFUSAL_ADVICE;
      throw new Error(
        `VidVNC is running (PID ${running.pid}, ${running.file}). ${advice} ` +
          'If VidVNC is not running, delete that file and try again.',
      );
    }
  };
  const saving = async (write) => {
    ensureStopped();
    try {
      return await write();
    } catch (error) {
      throw withConflictAdvice(error, RETRY);
    }
  };
  return {
    mode: 'offline',
    policy: () => store.snapshot(),
    updatePolicy: (summary, edit) =>
      saving(async () => {
        const current = store.snapshot();
        return {
          applied: true,
          policy: await store.replace(await edit(current), current.revision),
        };
      }),
    access: () => access.snapshot(),
    saveAccess: (changes) => saving(() => access.replace(changes, access.snapshot().revision)),
    // The same on-disk file loadTlsSettings reads at startup, validated with the same
    // graceful fallback (a missing file reads as the `auto` defaults; a broken or clashing
    // one reads as `off`, matching what a real startup would actually do next) — silent
    // here since this is a status read, not the startup log.
    tlsSettings: () =>
      loadTlsSettings(files.tls, { plaintextPort: plaintextPort(), log: () => {} }),
    // Read-merge-validate-write, unlike AccessSettings/StreamPolicyStore: TLS settings have
    // no revision/conflict-object scheme (see tls-settings.mjs), so the merge base is the
    // raw file content (or the defaults, if missing) rather than a validated-with-fallback
    // read — using the fallback here would risk silently discarding a still-valid field
    // (e.g. a configured certificate path) whenever some unrelated field made the file look
    // invalid under the *current* plaintext port. A validateTlsSettings failure is
    // surfaced as a UsageError with its message unchanged, never reworded.
    saveTls: (changes) =>
      saving(async () => {
        let base;
        try {
          base = JSON.parse(await readFile(files.tls, 'utf8'));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          base = defaultTlsSettings();
        }
        let validated;
        try {
          validated = validateTlsSettings(
            { ...base, ...changes },
            { plaintextPort: plaintextPort() },
          );
        } catch (error) {
          throw new UsageError(error.message);
        }
        await mkdir(directory, { recursive: true });
        await writeFile(files.tls, JSON.stringify(validated));
        return validated;
      }),
    orderedProfiles: () => applyProfileOrder(files.profileOrder, store.snapshot().profiles),
    saveProfileOrder: (ids) => saving(() => saveProfileOrder(files.profileOrder, ids)),
    async displays() {
      try {
        displays ??= new DisplayInventory(await listDisplays()).rows;
      } catch (error) {
        throw new Error(
          `Display information is unavailable: ${error.message}. Check that the media worker is installed and the graphics driver is working.`,
        );
      }
      return displays;
    },
    async hostCodecs() {
      try {
        codecs ??= await probeCodecs();
      } catch (error) {
        throw new Error(
          `Codec information is unavailable: ${error.message}. Check that the media worker is installed and the graphics driver is working.`,
        );
      }
      return codecs;
    },
    async info() {
      const running = runningInstances(files.instances, { alive });
      return [
        ['Data folder', directory],
        ['Log folder', logDirectory],
        [
          'Running servers',
          running.length
            ? running
                .map((row) => `PID ${row.pid} (${row.mode}${row.port ? `, port ${row.port}` : ''})`)
                .join(', ')
            : 'none',
        ],
      ];
    },
  };
}

export async function runOffline(argv, { stdout, stderr, ...options }) {
  try {
    const context = await createOfflineContext(options);
    const result = await execute(context, argv.length ? argv : ['help']);
    if (result.json) stdout.write(`${JSON.stringify(result.data ?? null, null, 2)}\n`);
    else if (result.text) stdout.write(`${result.text}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return error instanceof UsageError ? 2 : 1;
  }
}
