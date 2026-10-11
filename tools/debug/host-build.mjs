import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, utimesSync } from 'node:fs';
import path from 'node:path';

export function isStale(inputs, output, skip = []) {
  if (!existsSync(output)) return true;
  const built = statSync(output).mtimeMs;
  const pending = [...inputs];
  while (pending.length) {
    const entry = pending.pop();
    if (!existsSync(entry)) continue;
    const stat = statSync(entry);
    if (stat.isDirectory()) {
      for (const name of readdirSync(entry))
        if (!skip.includes(name)) pending.push(path.join(entry, name));
    } else if (stat.mtimeMs > built) return true;
  }
  return false;
}

export function workerPath(root, configuration, platform = process.platform) {
  return platform === 'darwin'
    ? path.join(root, 'out/native/macos-arm64', configuration, 'media-worker')
    : path.join(root, 'out/native/windows-x64', configuration, 'media-worker.exe');
}

export function workerIsStale(root, configuration) {
  return isStale(
    [
      path.join(root, 'native'),
      path.join(root, 'CMakeLists.txt'),
      path.join(root, 'CMakePresets.json'),
    ],
    workerPath(root, configuration),
    ['tests'],
  );
}

function run(root, command, args, capture = false) {
  const result = spawnSync(command, args, {
    cwd: root,
    windowsHide: true,
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status}): ${result.stderr || ''}`);
  return result.stdout?.trim();
}

export function hostProject(root, platform = process.platform) {
  return platform === 'darwin'
    ? path.join(root, 'apps/macos-host/VidVNC.xcodeproj')
    : path.join(root, 'apps/windows-host/VidVnc.Host.csproj');
}

// The macOS host's Xcode build output, kept out of the source tree like the worker's.
export function macHostDerivedData(root) {
  return path.join(root, 'out/macos-host/DerivedData');
}

// Where the macOS development manifest goes: the path the VidVNC scheme's Run action names
// in VIDVNC_RUNTIME_MANIFEST, so Xcode and start:host use the same one.
export function macManifestPath(root, configuration) {
  return path.join(root, 'out/macos-host', configuration, 'runtime.json');
}

// Signing for the macOS host: VIDVNC_SIGN_IDENTITY names a code-signing identity in the
// keychain (its common name or SHA-1). Without it the build is ad-hoc signed, which works but
// loses the Screen Recording and Accessibility grants on every rebuild.
export function macSigningArguments(env = process.env) {
  const identity = env.VIDVNC_SIGN_IDENTITY;
  if (!identity) return [];
  return [
    'CODE_SIGN_STYLE=Manual',
    `CODE_SIGN_IDENTITY=${identity}`,
    ...(env.VIDVNC_DEVELOPMENT_TEAM ? [`DEVELOPMENT_TEAM=${env.VIDVNC_DEVELOPMENT_TEAM}`] : []),
  ];
}

export function buildWorker(root, configuration) {
  if (process.platform === 'darwin') run(root, path.join(root, 'build-native.sh'), [configuration]);
  else
    run(root, process.env.ComSpec || 'cmd.exe', [
      '/d',
      '/c',
      `.\\build-native.cmd ${configuration}`,
    ]);
  // The staleness check compares the worker with every file under native/, but MSBuild relinks
  // it only when one of its own inputs changed: a header only another target uses (the
  // sandbox probe's sandbox.hpp, say) would leave it "stale" forever. A successful build means
  // the worker is current, so record that.
  const worker = workerPath(root, configuration);
  if (existsSync(worker)) {
    const now = new Date();
    utimesSync(worker, now, now);
  }
}

export function buildHost(root, configuration) {
  if (process.platform === 'darwin')
    run(root, 'xcodebuild', [
      '-project',
      hostProject(root),
      '-scheme',
      'VidVNC',
      '-configuration',
      configuration,
      '-derivedDataPath',
      macHostDerivedData(root),
      '-quiet',
      'build',
      ...macSigningArguments(),
    ]);
  else
    run(root, 'dotnet', ['build', hostProject(root), '-c', configuration, '-nologo', '-v:minimal']);
}

export function hostTarget(root, configuration) {
  if (process.platform === 'darwin')
    return path.join(macHostDerivedData(root), 'Build/Products', configuration, 'VidVNC.app');
  return run(
    root,
    'dotnet',
    ['msbuild', hostProject(root), `-p:Configuration=${configuration}`, '-getProperty:TargetPath'],
    true,
  );
}
