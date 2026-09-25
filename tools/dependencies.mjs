import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorker, workerIsStale, workerPath } from './debug/host-build.mjs';

// Brings what a test run depends on up to date before it starts, so a test never runs against
// yesterday's packages or worker and fails in a way that looks like a code bug:
//   - npm packages are reinstalled (`npm ci`) when node_modules does not match
//     package-lock.json;
//   - the development media worker is rebuilt (build-native.cmd, which also runs its C++ unit
//     tests) when it is older than native/ sources;
//   - the GStreamer SDK is checked against the version packaging pins. It is never downloaded
//     automatically (see the README), so a mismatch stops the run with install instructions.

export const root = fileURLToPath(new URL('../', import.meta.url));

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

// Why node_modules does not match the lockfile, or null when it does. Each package the
// lockfile lists must be installed at exactly its locked version, and each workspace link
// must exist. package.json must also still agree with the lockfile, or `npm ci` would refuse.
export function jsDependencyProblem(directory = root) {
  const lockFile = path.join(directory, 'package-lock.json');
  if (!existsSync(lockFile)) return 'package-lock.json is missing';
  const lock = readJson(lockFile);
  const manifest = readJson(path.join(directory, 'package.json'));
  const locked = lock.packages?.[''] ?? {};
  for (const field of ['dependencies', 'devDependencies'])
    for (const [name, range] of Object.entries(manifest[field] ?? {}))
      if (locked[field]?.[name] !== range)
        return `package.json and package-lock.json disagree about ${name}; run npm install and commit the lockfile`;
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith('node_modules/')) continue;
    const installed = path.join(directory, key, 'package.json');
    if (!existsSync(installed)) return `${key.slice('node_modules/'.length)} is not installed`;
    if (entry.link) continue;
    const version = readJson(installed).version;
    if (version !== entry.version)
      return `${key.slice('node_modules/'.length)} is ${version}, the lockfile pins ${entry.version}`;
  }
  return null;
}

function npm(args, directory) {
  // Inside `npm run`, npm_execpath is npm's own CLI script: run it with this Node, which
  // needs no shell on Windows. Outside npm, fall back to the npm on PATH.
  const cli = process.env.npm_execpath;
  const result = cli
    ? spawnSync(process.execPath, [cli, ...args], { cwd: directory, stdio: 'inherit' })
    : spawnSync('npm', args, {
        cwd: directory,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed (${result.status})`);
}

export function ensureJsDependencies({ directory = root, log = console.log } = {}) {
  const problem = jsDependencyProblem(directory);
  if (!problem) return false;
  if (/disagree/.test(problem)) throw new Error(problem);
  log(`npm packages are out of date (${problem}); running npm ci...`);
  npm(['ci', '--no-audit', '--no-fund'], directory);
  const remaining = jsDependencyProblem(directory);
  if (remaining) throw new Error(`npm ci did not bring packages up to date: ${remaining}`);
  return true;
}

// The pinned GStreamer version (packaging/windows/inputs.json) against the SDK's own
// pkg-config file. Returns a message to act on, or null.
export function gstreamerProblem({
  directory = root,
  sdk = process.env.GSTREAMER_ROOT || path.join(directory, '.deps/gstreamer'),
} = {}) {
  const pinned = readJson(path.join(directory, 'packaging/windows/inputs.json')).gstreamer;
  const pc = path.join(sdk, 'lib/pkgconfig/gstreamer-1.0.pc');
  const install = `Install GStreamer ${pinned.version} (${pinned.installer.file}, SHA-256 ${pinned.installer.sha256}) to ${sdk}, or set GSTREAMER_ROOT.`;
  if (!existsSync(path.join(sdk, 'bin')))
    return `The GStreamer SDK was not found at ${sdk}. ${install}`;
  // An SDK without its pkg-config file cannot say its version; the build still decides.
  if (!existsSync(pc)) return null;
  const version = /^Version:\s*(\S+)/m.exec(readFileSync(pc, 'utf8'))?.[1];
  if (version !== pinned.version)
    return `The GStreamer SDK at ${sdk} is ${version ?? 'an unknown version'}; VidVNC pins ${pinned.version}. ${install}`;
  return null;
}

// Rebuilds the development Release worker when it is older than its sources. Skipped when the
// caller chose a worker explicitly (VIDVNC_MEDIA_WORKER, or a runtime manifest).
export function ensureNativeWorker({
  directory = root,
  configuration = 'Release',
  log = console.log,
} = {}) {
  if (process.env.VIDVNC_MEDIA_WORKER || process.env.VIDVNC_RUNTIME_MANIFEST) return false;
  if (process.platform !== 'win32') throw new Error('The media worker builds on Windows only');
  const sdk = gstreamerProblem({ directory });
  if (sdk) throw new Error(sdk);
  if (!workerIsStale(directory, configuration)) return false;
  log(
    `The media worker is older than native/ sources; building ${workerPath(directory, configuration)}...`,
  );
  buildWorker(directory, configuration);
  return true;
}
