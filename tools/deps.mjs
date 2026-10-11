// `npm run deps`: sets up everything a checkout keeps in .deps/, so a fresh clone (or a
// second checkout for a branch) is ready to build, test and package with one command:
//   - npm packages, from package-lock.json (`npm ci` when they do not match);
//   - the GStreamer SDK: .deps/gstreamer links to the user's (or machine's) installed
//     GStreamer of the pinned version (packaging/windows/inputs.json), which the pinned
//     official installer installs for the current user, with the development files, when
//     there is none;
//   - portable CMake in .deps/cmake (tools/deps.json), which build-native.cmd prefers;
//   - on macOS, nothing in .deps: it checks the user's GStreamer framework, Xcode and CMake
//     instead, and says what to install;
//   - the packaging inputs in .deps/downloads and the development certificate in
//     .deps/signing (packaging/windows/prepare.mjs).
// Every download is checked against its pinned SHA-256 before it is used, and every step is
// skipped when what it would produce is already there. Builds and tests still never
// download anything themselves (tools/dependencies.mjs only checks).
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultSdk, ensureJsDependencies, gstreamerProblem, root } from './dependencies.mjs';

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

// The GStreamer installer is Inno Setup. It does not change environment variables, but it
// registers itself as one installed app for the user, so a checkout cannot keep its own
// copy: there is one GStreamer per user (or per machine), in its installer's default
// folder, and each checkout's .deps/gstreamer links to it. A silent, per-user install of
// the runtime and the development files:
export function gstreamerInstallArgs(log) {
  return [
    '/VERYSILENT',
    '/SUPPRESSMSGBOXES',
    '/NORESTART',
    '/SP-',
    '/CURRENTUSER',
    '/TYPE=devel',
    `/LOG=${log}`,
  ];
}

// The GStreamer installations Windows lists under Installed apps, for the user and the
// machine, as { name, version, location }.
const INSTALLED_APPS = `
$keys = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
$apps = @(Get-ItemProperty -Path $keys -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -like '*GStreamer*' -and $_.InstallLocation } |
  ForEach-Object { [pscustomobject]@{ name = $_.DisplayName; version = $_.DisplayVersion; location = $_.InstallLocation } })
ConvertTo-Json -Compress -InputObject $apps
`;

export function registeredGStreamer({ execute = run } = {}) {
  const result = execute(
    path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    ),
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(INSTALLED_APPS, 'utf16le').toString('base64'),
    ],
  );
  if (result.status !== 0) throw new Error(`Listing installed apps failed: ${result.stderr}`);
  return parseInstalls(result.stdout);
}

export function parseInstalls(output) {
  const text = (output ?? '').trim();
  if (!text) return [];
  const value = JSON.parse(text);
  return (Array.isArray(value) ? value : [value]).map((row) => ({
    name: String(row.name),
    version: row.version == null ? null : String(row.version),
    location: String(row.location).replace(/[\\/]+$/, ''),
  }));
}

// The installation to use: one whose own pkg-config file says the pinned version (so it has
// the development files), else null. `others` lists the ones that do not qualify and why.
export function chooseInstall(installs, check) {
  const others = [];
  for (const install of installs) {
    const problem = check(install.location);
    if (!problem) return { install, others };
    others.push({ ...install, problem });
  }
  return { install: null, others };
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

// Whether `sdk` is a usable SDK of the pinned version with its development files.
function sdkProblem(directory, sdk) {
  // The same files the worker build needs (native/media-worker/CMakeLists.txt): a runtime-only
  // install has neither.
  for (const file of ['include/gstreamer-1.0/gst/gst.h', 'lib/pkgconfig/gstreamer-1.0.pc'])
    if (!existsSync(path.join(sdk, file))) return `no development files at ${sdk} (${file})`;
  return gstreamerProblem({ directory, sdk });
}

async function ensureGStreamer({ directory, log }) {
  const pinned = readJson(path.join(directory, 'packaging/windows/inputs.json')).gstreamer;
  if (process.env.GSTREAMER_ROOT) {
    const problem = gstreamerProblem({ directory });
    if (problem) throw new Error(`${problem} (GSTREAMER_ROOT is set, so it is not installed)`);
    return log(`GStreamer: using GSTREAMER_ROOT (${process.env.GSTREAMER_ROOT}).`);
  }
  const link = path.join(directory, pinned.sdk);
  if (!sdkProblem(directory, link)) return log(`GStreamer: ${pinned.version} is ready at ${link}.`);
  const check = (sdk) => sdkProblem(directory, sdk);
  let { install, others } = chooseInstall(registeredGStreamer(), check);
  if (!install) {
    // Never replace or upgrade an installation something else may be using.
    if (others.length)
      throw new Error(
        `GStreamer is installed, but not as VidVNC needs it (${pinned.version} with development files):\n${others
          .map((other) => `  ${other.name} at ${other.location}: ${other.problem}`)
          .join(
            '\n',
          )}\nUninstall it or install ${pinned.version} yourself, or set GSTREAMER_ROOT, then run npm run deps again.`,
      );
    const downloads = path.join(directory, '.deps/downloads');
    const installer = await downloadVerified(pinned.installer, { directory: downloads, log });
    log(`GStreamer: installing ${pinned.version} for this user...`);
    const result = run(
      installer,
      gstreamerInstallArgs(path.join(downloads, 'gstreamer-install.log')),
      {
        stdio: 'inherit',
      },
    );
    if (result.status !== 0) throw new Error(`The GStreamer installer failed (${result.status})`);
    ({ install, others } = chooseInstall(registeredGStreamer(), check));
    if (!install)
      throw new Error(
        `The GStreamer installer finished, but no installed GStreamer ${pinned.version} was found (see ${path.join(downloads, 'gstreamer-install.log')}).`,
      );
  }
  // .deps/gstreamer becomes a junction to it; a real folder there is never replaced.
  let existing = null;
  try {
    existing = lstatSync(link);
  } catch {
    // Nothing there yet.
  }
  if (existing && !existing.isSymbolicLink())
    throw new Error(
      `${link} holds another GStreamer (${sdkProblem(directory, link)}); move it away or uninstall it, then run npm run deps again.`,
    );
  if (existing) rmSync(link);
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(install.location, link, 'junction');
  log(`GStreamer: ${link} now points to ${install.name} at ${install.location}.`);
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
  // Windows' own tar (bsdtar) extracts ZIP files. Straight into place, without the archive's
  // top folder: renaming a just-extracted folder fails while Windows Defender scans it. A
  // half-extracted folder is removed, and one that survives a crash fails the version check
  // above, so the next run replaces it.
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  const result = run('tar', ['-xf', archive, '--strip-components', '1', '-C', target], {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    rmSync(target, { recursive: true, force: true });
    throw new Error(`Extracting ${archive} failed (${result.status})`);
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

// The GStreamer framework's packages for macOS, at the version Windows pins.
export function macosGStreamerPackages(version) {
  const base = `https://gstreamer.freedesktop.org/data/pkg/osx/${version}`;
  return [
    `${base}/gstreamer-1.0-${version}-universal.pkg`,
    `${base}/gstreamer-1.0-devel-${version}-universal.pkg`,
  ];
}

// On macOS a checkout links nothing into .deps: the build and the server use the GStreamer
// framework the user installed, in ~/Library/Frameworks (or /Library/Frameworks), one copy
// for every checkout (native/media-worker/CMakeLists.txt and runtime-paths.mjs find it the
// same way). This checks it and the build tools, and says what to install when one is missing.
export function macosProblems({ directory = root, execute = run } = {}) {
  const problems = [];
  const pinned = readJson(path.join(directory, 'packaging/windows/inputs.json')).gstreamer;
  const sdk = defaultSdk(directory, 'darwin');
  const gstreamer = sdkProblem(directory, sdk);
  if (gstreamer)
    problems.push(
      `GStreamer: ${gstreamer}. Install both packages with "Install for me only", or set GSTREAMER_ROOT:\n${macosGStreamerPackages(
        pinned.version,
      )
        .map((url) => `    ${url}`)
        .join('\n')}`,
    );
  const found = (command, args) => {
    try {
      return execute(command, args).status === 0;
    } catch {
      return false;
    }
  };
  if (!found('xcodebuild', ['-version']))
    problems.push('Xcode: install Xcode and run xcode-select -s /Applications/Xcode.app.');
  if (!found('cmake', ['--version']))
    problems.push('CMake: install CMake 3.25 or newer (brew install cmake, or from cmake.org).');
  return problems;
}

function ensureMacosTools({ directory, log }) {
  const problems = macosProblems({ directory });
  if (problems.length) throw new Error(problems.join('\n'));
  log(`GStreamer: using the installed framework at ${defaultSdk(directory, 'darwin')}.`);
  log('Xcode and CMake: installed.');
}

export async function setUpDependencies({ directory = root, log = console.log } = {}) {
  if (!ensureJsDependencies({ directory, log })) log('npm packages: up to date.');
  if (process.platform === 'darwin') {
    ensureMacosTools({ directory, log });
    log('All dependencies are ready.');
    return;
  }
  if (process.platform !== 'win32')
    throw new Error('npm run deps sets up Windows and macOS checkouts only.');
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
