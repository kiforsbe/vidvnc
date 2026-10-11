// Process-tree check for the macOS host (plan task 5.3): start sharing, kill VidVNC with
// SIGKILL, and require that no server process outlives it. macOS has no job object, so this
// is what the owner pipe and the server's parent watch have to guarantee.
//
//   node apps/macos-host/tests/process-tree.mjs [--real] [Debug|Release]
//
// By default the server is the stand-in (stand-in-server.mjs). With --real it is the real
// server from out/macos-host/<configuration>/runtime.json (run `npm run prepare:host` first),
// which also starts the media relay under its sandbox launcher. No viewer connects, so
// nothing is captured and the Debug build's test switch stands in for Screen Recording.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeDevelopmentManifest } from '../../../tools/debug/runtime.mjs';
import { hostTarget, macManifestPath } from '../../../tools/debug/host-build.mjs';
import { defaultGStreamerRoot } from '../../../native/media-worker/runtime-paths.mjs';

const real = process.argv.includes('--real');
const configuration = process.argv.find((value) => ['Debug', 'Release'].includes(value)) ?? 'Debug';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const app = hostTarget(root, configuration);
const executable = path.join(app, 'Contents/MacOS/VidVNC');
if (!existsSync(executable))
  throw new Error(`Build the app first: npm run prepare:host -- ${configuration}`);

const scratch = mkdtempSync(path.join(tmpdir(), 'vidvnc-process-tree-'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// Every process whose command line names the server entry point.
const serverProcesses = (server) =>
  spawnSync('pgrep', ['-f', server], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter(Boolean)
    .map(Number);

try {
  let manifest;
  let server;
  if (real) {
    manifest = macManifestPath(root, configuration);
    if (!existsSync(manifest))
      throw new Error(`Run npm run prepare:host -- ${configuration} first`);
    server = JSON.parse(readFileSync(manifest, 'utf8')).server;
  } else {
    // A development manifest like prepare:host's, with the stand-in as the server.
    manifest = path.join(scratch, 'runtime.json');
    writeDevelopmentManifest({
      root,
      configuration,
      filename: manifest,
      sdk: defaultGStreamerRoot({ root }),
    });
    server = fileURLToPath(new URL('stand-in-server.mjs', import.meta.url));
    const data = JSON.parse(readFileSync(manifest, 'utf8'));
    writeFileSync(manifest, JSON.stringify({ ...data, server }, null, 2));
  }
  if (serverProcesses(server).length)
    throw new Error('A server is already running; stop it first.');

  const host = spawn(executable, ['-startSharing', 'YES', '-ApplePersistenceIgnoreState', 'YES'], {
    env: {
      ...process.env,
      VIDVNC_RUNTIME_MANIFEST: manifest,
      VIDVNC_TEST_ASSUME_SCREEN_RECORDING: '1',
    },
    stdio: 'ignore',
  });
  let started = [];
  for (let i = 0; i < 100 && !started.length; i++) {
    await sleep(200);
    started = serverProcesses(server);
  }
  if (!started.length) throw new Error('The server did not start');
  // Let a real server bring up its relay and workers.
  await sleep(real ? 5000 : 1000);
  const tree = spawnSync('pgrep', ['-g', String(started[0])], { encoding: 'utf8' })
    .stdout.split('\n')
    .filter(Boolean)
    .map(Number);
  console.log(`VidVNC ${host.pid}, server ${started.join(', ')}, server group ${tree.join(', ')}`);

  process.kill(host.pid, 'SIGKILL');
  const deadline = Date.now() + 10_000;
  let left = [...new Set([...started, ...tree])].filter(alive);
  while (left.length && Date.now() < deadline) {
    await sleep(200);
    left = left.filter(alive);
  }
  if (left.length) {
    for (const pid of left) process.kill(pid, 'SIGKILL');
    throw new Error(`Still running 10 s after VidVNC was killed: ${left.join(', ')}`);
  }
  console.log(`No VidVNC process survived (${(10_000 - (deadline - Date.now())) / 1000} s).`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
