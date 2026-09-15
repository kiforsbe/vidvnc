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

// Moves a completely built tree to `destination`, then deletes the tree it replaced.
export function replaceDirectory(built, destination) {
  if (path.dirname(path.resolve(built)) !== path.dirname(path.resolve(destination)))
    throw new Error(`${built} is not a sibling of ${destination}`);
  let previous;
  if (plainDirectory(destination)) {
    previous = `${built}.previous`;
    renameSync(destination, previous);
  }
  renameSync(built, destination);
  if (previous) rmSync(previous, { recursive: true, force: true });
}
