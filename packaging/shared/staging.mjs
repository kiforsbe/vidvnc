import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

const TARGET = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$/;

// Throws unless `directory` is absent (false) or a real directory (true); links and junctions are refused.
function plainDirectory(directory) {
  let stats;
  try {
    stats = lstatSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory())
    throw new Error(`Unsafe output path: ${directory} is not a plain directory`);
  return true;
}

function ensureDirectory(root, segments) {
  let current = path.resolve(root);
  for (const segment of segments) {
    current = path.join(current, segment);
    if (!plainDirectory(current)) mkdirSync(current);
  }
  return current;
}

// Staging and artifact directories for one build, created under <root>/out only.
export function outputLocations(root, { target, configuration, version }) {
  if (!TARGET.test(target)) throw new Error(`Invalid target: ${target}`);
  if (!['Debug', 'Release'].includes(configuration))
    throw new Error(`Invalid configuration: ${configuration}`);
  if (!VERSION.test(version)) throw new Error(`Invalid version: ${version}`);
  return {
    stage: path.join(ensureDirectory(root, ['out', 'packages', target]), configuration),
    installers: ensureDirectory(root, ['out', 'installers', target, version]),
  };
}

// A new, uniquely named empty directory next to `destination`.
export function siblingDirectory(destination) {
  const directory = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}-${randomUUID()}`,
  );
  mkdirSync(directory);
  return directory;
}

const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Antivirus scanners and indexers briefly lock freshly written files on Windows.
function renameRetrying(from, to, rename, pause) {
  for (let attempt = 1; ; attempt++) {
    try {
      return rename(from, to);
    } catch (error) {
      if (attempt >= 8 || !TRANSIENT.has(error.code)) throw error;
      pause(250 * attempt);
    }
  }
}

// Moves a completely built tree to `destination`, then deletes the tree it replaced. If the
// built tree cannot be moved in, the replaced tree is put back and `built` is left for the
// caller to remove.
export function replaceDirectory(built, destination, { rename = renameSync, pause = sleep } = {}) {
  if (path.dirname(path.resolve(built)) !== path.dirname(path.resolve(destination)))
    throw new Error(`${built} is not a sibling of ${destination}`);
  let previous;
  if (plainDirectory(destination)) {
    previous = `${built}.previous`;
    renameRetrying(destination, previous, rename, pause);
  }
  try {
    renameRetrying(built, destination, rename, pause);
  } catch (error) {
    if (previous) renameRetrying(previous, destination, rename, pause);
    throw error;
  }
  if (previous) rmSync(previous, { recursive: true, force: true });
}
