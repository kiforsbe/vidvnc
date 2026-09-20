import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { writeDevelopmentManifest } from './runtime.mjs';
import { buildHost, buildWorker, hostTarget, workerIsStale } from './host-build.mjs';

const configuration = process.argv[2] || 'Debug';
if (process.argv.length > 3 || !['Debug', 'Release'].includes(configuration))
  throw new Error('Usage: node tools/debug/start-host.mjs [Debug|Release]');
if (process.platform !== 'win32') throw new Error('The Windows host requires Windows');
const root = fileURLToPath(new URL('../../', import.meta.url));
const running = spawnSync('tasklist', ['/FI', 'IMAGENAME eq VidVnc.Host.exe', '/NH'], {
  encoding: 'utf8',
  windowsHide: true,
});
if (/VidVnc\.Host\.exe/i.test(running.stdout))
  throw new Error('VidVNC is already running. Close it first; it would block the rebuild.');
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
