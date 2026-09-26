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

export function workerPath(root, configuration) {
  return path.join(root, 'out/native/windows-x64', configuration, 'media-worker.exe');
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

export function hostProject(root) {
  return path.join(root, 'apps/windows-host/VidVnc.Host.csproj');
}

export function buildWorker(root, configuration) {
  run(root, process.env.ComSpec || 'cmd.exe', ['/d', '/c', `.\\build-native.cmd ${configuration}`]);
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
  run(root, 'dotnet', ['build', hostProject(root), '-c', configuration, '-nologo', '-v:minimal']);
}

export function hostTarget(root, configuration) {
  return run(
    root,
    'dotnet',
    ['msbuild', hostProject(root), `-p:Configuration=${configuration}`, '-getProperty:TargetPath'],
    true,
  );
}
