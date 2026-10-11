import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeDevelopmentManifest } from './runtime.mjs';
import {
  buildHost,
  buildWorker,
  hostTarget,
  macManifestPath,
  workerIsStale,
} from './host-build.mjs';
import { defaultGStreamerRoot } from '../../native/media-worker/runtime-paths.mjs';

const configuration = process.argv[2] || 'Debug';
if (process.argv.length > 3 || !['Debug', 'Release'].includes(configuration))
  throw new Error('Usage: node tools/debug/start-host.mjs [Debug|Release]');
if (!['win32', 'darwin'].includes(process.platform))
  throw new Error('The host requires Windows or macOS');
const root = fileURLToPath(new URL('../../', import.meta.url));
if (process.platform === 'darwin') {
  startMacHost();
} else {
  startWindowsHost();
}

// macOS: build the worker if it is stale and the app, write the manifest, then open the app
// through Launch Services. Started that way, VidVNC is its own responsible process, so macOS
// asks for and records privacy permissions for VidVNC rather than for Terminal.
function startMacHost() {
  const running = spawnSync('pgrep', ['-x', 'VidVNC'], { encoding: 'utf8' });
  if (running.status === 0)
    throw new Error(
      'VidVNC is already running. Quit it first (VidVNC in the menu bar, then Quit VidVNC).',
    );
  if (workerIsStale(root, configuration)) {
    console.log(`Media worker is out of date; building the ${configuration} worker...`);
    buildWorker(root, configuration);
  }
  buildHost(root, configuration);
  const app = hostTarget(root, configuration);
  const manifest = macManifestPath(root, configuration);
  writeDevelopmentManifest({
    root,
    configuration,
    filename: manifest,
    sdk: defaultGStreamerRoot({ root }),
  });
  const inspect = process.env.VIDVNC_INSPECT === '1' ? ['--env', 'VIDVNC_INSPECT=1'] : [];
  const host = spawn(
    'open',
    ['-W', '-n', '--env', `VIDVNC_RUNTIME_MANIFEST=${manifest}`, ...inspect, app],
    { stdio: 'inherit' },
  );
  host.on('error', (error) => {
    throw error;
  });
  host.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}

function startWindowsHost() {
  const running = spawnSync('tasklist', ['/FI', 'IMAGENAME eq VidVnc.Host.exe', '/NH'], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (/VidVnc\.Host\.exe/i.test(running.stdout))
    throw new Error(
      'VidVNC is already running. Quit it first (right-click its icon in the notification area and choose Quit VidVNC); it would block the rebuild.',
    );
  if (workerIsStale(root, configuration)) {
    console.log(`Media worker is out of date; building the ${configuration} worker...`);
    buildWorker(root, configuration);
  }
  buildHost(root, configuration);
  const target = hostTarget(root, configuration).replace(/\.dll$/i, '.exe');
  writeDevelopmentManifest({
    root,
    configuration,
    filename: path.join(path.dirname(target), 'runtime.json'),
    sdk: process.env.GSTREAMER_ROOT || path.join(root, '.deps/gstreamer'),
  });
  const host = spawn(target, [], { cwd: path.dirname(target), stdio: 'inherit' });
  host.on('error', (error) => {
    throw error;
  });
  host.on('exit', (code) => {
    process.exitCode = code ?? 1;
  });
}
