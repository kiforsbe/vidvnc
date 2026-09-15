import { AccessSettings } from '../access-settings.mjs';
import { DisplayInventory } from '../displays.mjs';
import { isAlive, runningInstances } from '../instances.mjs';
import { settingsFiles } from '../paths.mjs';
import { applyProfileOrder, saveProfileOrder } from '../profile-order.mjs';
import { StreamPolicyStore } from '../stream-policy-store.mjs';
import { execute } from './commands.mjs';
import { withConflictAdvice } from './conflict-advice.mjs';
import { UsageError } from './usage-error.mjs';

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

export async function createOfflineContext({
  directory,
  logDirectory,
  listDisplays = defaultListDisplays,
  alive = isAlive,
}) {
  const files = settingsFiles(directory);
  const store = await StreamPolicyStore.open(files.policy);
  const access = await AccessSettings.open(files.access);
  let displays;
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
    saveAccess: (value) => saving(() => access.replace(value, access.snapshot().revision)),
    orderedProfiles: () => applyProfileOrder(files.profileOrder, store.snapshot().profiles),
    saveProfileOrder: (ids) => saving(() => saveProfileOrder(files.profileOrder, ids)),
    async displays() {
      try {
        displays ??= new DisplayInventory(await listDisplays()).rows;
      } catch (error) {
        throw new Error(
          `Display information is unavailable: ${error.message}. Check that the media worker is installed and the NVIDIA driver is working.`,
        );
      }
      return displays;
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
