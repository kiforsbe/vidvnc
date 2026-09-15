import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INSTANCE_FILE = /^([1-9]\d{0,9})\.json$/;

// Files left behind by a killed process are never cleaned up by their owner, and
// Windows reuses PIDs, so they would otherwise cause growing false refusals over
// time. Remove any instance file whose PID is no longer alive before registering.
function removeStaleInstanceFiles(folder, pid, alive) {
  let names;
  try {
    names = readdirSync(folder);
  } catch {
    return;
  }
  for (const name of names) {
    const match = INSTANCE_FILE.exec(name);
    if (!match) continue;
    const filePid = Number(match[1]);
    if (filePid === pid || alive(filePid)) continue;
    try {
      rmSync(join(folder, name), { force: true });
    } catch {
      // Another process may already have removed it.
    }
  }
}

// Lets offline config commands detect a running server. A stale file (dead PID)
// is ignored; PID reuse can only cause a refusal, which fails safe.
export function registerInstance(
  folder,
  { mode, port, pid = process.pid, now = Date.now(), alive = isAlive },
) {
  const file = join(folder, `${pid}.json`);
  mkdirSync(folder, { recursive: true });
  removeStaleInstanceFiles(folder, pid, alive);
  writeFileSync(file, JSON.stringify({ pid, startedAt: now, mode, port }), { mode: 0o600 });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(file, { force: true });
  };
}

export function isAlive(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function runningInstances(folder, { alive = isAlive } = {}) {
  let names;
  try {
    names = readdirSync(folder);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const rows = [];
  for (const name of names.sort()) {
    const match = INSTANCE_FILE.exec(name);
    if (!match || !alive(Number(match[1]))) continue;
    const file = join(folder, name);
    let details = {};
    try {
      details = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // An unreadable record still marks a live PID as running.
    }
    if (typeof details !== 'object' || details === null) details = {};
    rows.push({
      pid: Number(match[1]),
      file,
      mode: typeof details.mode === 'string' ? details.mode : 'unknown',
      port: Number.isInteger(details.port) ? details.port : null,
    });
  }
  return rows;
}
