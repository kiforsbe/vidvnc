// `npm run deps`: sets up everything a checkout keeps in .deps/, so a fresh clone (or a
// second checkout for a branch) is ready to build, test and package with one command:
//   - npm packages, from package-lock.json (`npm ci` when they do not match);
//   - the GStreamer SDK in .deps/gstreamer, from the pinned official installer
//     (packaging/windows/inputs.json), installed for the current user with the
//     development files;
//   - portable CMake in .deps/cmake (tools/deps.json), which build-native.cmd prefers;
//   - the packaging inputs in .deps/downloads and the development certificate in
//     .deps/signing (packaging/windows/prepare.mjs).
// Every download is checked against its pinned SHA-256 before it is used, and every step is
// skipped when what it would produce is already there. Builds and tests still never
// download anything themselves (tools/dependencies.mjs only checks).
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureJsDependencies, gstreamerProblem, root } from './dependencies.mjs';

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Downloads `item` ({ file, url, sha256 }) into `directory` unless a verified copy is there.
// Returns the file's path. A download that does not match its pin is never written.
export async function downloadVerified(
  item,
  {
    directory = path.join(root, '.deps/downloads'),
    fetch = globalThis.fetch,
    log = console.log,
  } = {},
) {
  const filename = path.join(directory, item.file);
  if (existsSync(filename) && sha256(readFileSync(filename)) === item.sha256) return filename;
  log(`Downloading ${item.url}...`);
  const response = await fetch(item.url);
  if (!response.ok) throw new Error(`Download failed (${response.status}) from ${item.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256(bytes);
  if (actual !== item.sha256)
    throw new Error(`SHA-256 mismatch for ${item.url}: expected ${item.sha256}, got ${actual}`);
  mkdirSync(directory, { recursive: true });
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: 'wx' });
    renameSync(temporary, filename);
  } finally {
    rmSync(temporary, { force: true });
  }
  return filename;
}

// The GStreamer installer is Inno Setup: a silent, per-user install of the runtime and the
// development files into `sdk`. It registers an uninstaller (unins000.exe in the SDK) and
// may set the user's GSTREAMER_1_0_ROOT_MSVC_X86_64 variable; VidVNC does not read it.
export function gstreamerInstallArgs(sdk) {
  return [
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    '/SP-',
    '/CURRENTUSER',
    '/TYPE=devel',
    `/DIR=${sdk}`,
    `/LOG=${path.join(path.dirname(sdk), 'downloads', 'gstreamer-install.log')}`,
  ];
}

// The version `cmake --version` prints, or null.
export function cmakeVersion(output) {
  return /^cmake version (\S+)/m.exec(output ?? '')?.[1] ?? null;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { windowsHide: true, encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}

async function ensureGStreamer({ directory, log }) {
  const pinned = readJson(path.join(directory, 'packaging/windows/inputs.json')).gstreamer;
  if (process.env.GSTREAMER_ROOT) {
    const problem = gstreamerProblem({ directory });
    if (problem) throw new Error(`${problem} (GSTREAMER_ROOT is set, so it is not installed)`);
    return log(`GStreamer: using GSTREAMER_ROOT (${process.env.GSTREAMER_ROOT}).`);
  }
  const sdk = path.join(directory, pinned.sdk);
  if (!gstreamerProblem({ directory, sdk }))
    return log(`GStreamer: ${pinned.version} is installed.`);
  // Installing over another version would leave its files behind.
  if (existsSync(path.join(sdk, 'bin')))
    throw new Error(
      `${gstreamerProblem({ directory, sdk })}\nUninstall it first (${path.join(sdk, 'unins000.exe')}), then run npm run deps again.`,
    );
  const installer = await downloadVerified(pinned.installer, {
    directory: path.join(directory, '.deps/downloads'),
    log,
  });
  log(`GStreamer: installing ${pinned.version} into ${sdk}...`);
  const result = run(installer, gstreamerInstallArgs(sdk), { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`The GStreamer installer failed (${result.status})`);
  const problem = gstreamerProblem({ directory, sdk });
  if (problem) throw new Error(`The GStreamer installer finished, but: ${problem}`);
  log(`GStreamer: ${pinned.version} installed.`);
}

async function ensureCMake({ directory, log }) {
  const { cmake } = readJson(path.join(directory, 'tools/deps.json'));
  const target = path.join(directory, cmake.directory);
  const executable = path.join(target, 'bin/cmake.exe');
  if (
    existsSync(executable) &&
    cmakeVersion(run(executable, ['--version']).stdout) === cmake.version
  )
    return log(`CMake: ${cmake.version} is installed.`);
  const archive = await downloadVerified(cmake.archive, {
    directory: path.join(directory, '.deps/downloads'),
    log,
  });
  // Windows' own tar (bsdtar) extracts ZIP files.
  const staging = `${target}.${randomUUID()}.tmp`;
  mkdirSync(staging, { recursive: true });
  try {
    const result = run('tar', ['-xf', archive, '-C', staging], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`Extracting ${archive} failed (${result.status})`);
    rmSync(target, { recursive: true, force: true });
    renameSync(path.join(staging, cmake.archive.file.replace(/\.zip$/, '')), target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  log(`CMake: ${cmake.version} installed in ${target}.`);
}

function preparePackaging({ directory }) {
  const result = run(process.execPath, [path.join(directory, 'packaging/windows/prepare.mjs')], {
    cwd: directory,
    stdio: 'inherit',
  });
  if (result.status !== 0)
    throw new Error(`packaging/windows/prepare.mjs failed (${result.status})`);
}

export async function setUpDependencies({ directory = root, log = console.log } = {}) {
  if (!ensureJsDependencies({ directory, log })) log('npm packages: up to date.');
  if (process.platform !== 'win32') {
    log(
      'The GStreamer SDK, CMake and packaging inputs are set up on Windows only for now; on macOS install the GStreamer 1.28.6 framework (README, SDK and build locations).',
    );
    return;
  }
  await ensureGStreamer({ directory, log });
  await ensureCMake({ directory, log });
  preparePackaging({ directory });
  log('All dependencies are ready.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await setUpDependencies();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
