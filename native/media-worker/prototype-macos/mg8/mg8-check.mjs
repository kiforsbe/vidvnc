// MG8 prototype only (throwaway): run by the bundle's server Node. Checks, from inside the
// signed bundle, that every component starts and works:
//   1. this Node (hardened runtime, allow-jit only): JIT-heavy JS and WebAssembly;
//   2. the relay Node (no entitlements) with --jitless and --permission, from the bundle on its
//      command line, under its SBPL profile through the bundled sandbox launcher: it must reach
//      "ready" on a UDP port;
//   3. the worker's self-check (bundled GStreamer, webrtcbin, Opus, VideoToolbox);
//   4. the same self-check (minus VideoToolbox) under media-net's SBPL profile.
// Prints one JSON object; "ok" is true only if all four pass.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const macos = path.dirname(process.execPath);
const contents = path.dirname(macos);
// The sandbox profiles read the bundle's Contents (Frameworks and Library/GStreamer).
const gstreamer = contents;
const worker = path.join(macos, 'media-worker');
const launcher = path.join(macos, 'sandbox-launcher');
const relayNode = path.join(macos, 'node-relay');
const cache = path.join(homedir(), '.cache/gstreamer-1.0');
mkdirSync(cache, { recursive: true });
const work = path.join(tmpdir(), `vidvnc-mg8-${process.pid}`);
mkdirSync(work, { recursive: true });

// GStreamer from the bundle only: its plugins, a registry of its own, no scanner process.
const gstEnv = {
  ...process.env,
  GST_PLUGIN_SYSTEM_PATH_1_0: path.join(contents, 'Library/GStreamer'),
  GST_PLUGIN_PATH_1_0: '',
  GST_REGISTRY_1_0: path.join(cache, 'vidvnc-mg8-registry.bin'),
  GST_REGISTRY_FORK: 'no',
};
const result = { bundle: path.dirname(contents), node: process.version };
const lastJson = (text) =>
  text
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line))
    .at(-1) ?? { ok: false, output: text.slice(-400) };

// 1. This Node.
{
  let x = 0;
  for (let i = 0; i < 5e7; i++) x = (x + i * 7) % 1000003;
  const bytes = new Uint8Array([
    0, 97, 115, 109, 1, 0, 0, 0, 1, 7, 1, 96, 2, 127, 127, 1, 127, 3, 2, 1, 0, 7, 7, 1, 3, 97, 100,
    100, 0, 0, 10, 9, 1, 7, 0, 32, 0, 32, 1, 106, 11,
  ]);
  const wasm = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports.add(2, 3);
  result.serverNode = { ok: wasm === 5 && x > 0, wasm };
}

// 2. The relay: bundle source on the command line, sandboxed, jitless, permission model.
{
  const profile = path.join(work, 'relay.sb');
  writeFileSync(profile, execFileSync(launcher, ['--print-relay-profile', relayNode], { encoding: 'utf8' }));
  const source = readFileSync(path.join(contents, 'Resources/relay-bundle.js'), 'utf8');
  const relay = spawn(
    launcher,
    ['--launch', profile, '--', relayNode, '--jitless', '--permission', '--input-type=module', '-e', source],
    { stdio: ['pipe', 'pipe', 'pipe'], cwd: '/' },
  );
  let out = '';
  let errors = '';
  relay.stdout.on('data', (data) => (out += data));
  relay.stderr.on('data', (data) => (errors += data));
  relay.stdin.on('error', () => {});
  relay.stdin.write(`${JSON.stringify({ type: 'start', port: 47384 })}\n`);
  const ready = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10000);
    relay.stdout.on('data', () => {
      const line = out.split('\n').find((row) => row.includes('"ready"') || row.includes('"failed"'));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line));
      }
    });
    relay.on('exit', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
  const sandboxed = execFileSync(launcher, ['--is-sandboxed', String(relay.pid)], {
    encoding: 'utf8',
  }).trim();
  relay.stdin.end(`${JSON.stringify({ type: 'stop' })}\n`);
  result.relay = {
    ok: ready?.type === 'ready' && sandboxed === 'sandboxed',
    ready,
    sandboxed,
    stderr: errors.slice(0, 300),
  };
}

// 3. The worker, unsandboxed (it captures and encodes).
{
  const run = spawnSync(worker, ['--self-check'], { encoding: 'utf8', env: gstEnv, cwd: '/' });
  result.worker = lastJson(`${run.stdout}`);
  if (!result.worker.ok) result.worker.stderr = run.stderr.slice(-400);
}

// 4. media-net's half, under its profile through the launcher (the registry exists by now).
{
  const profile = path.join(work, 'media-net.sb');
  writeFileSync(
    profile,
    execFileSync(launcher, ['--print-profile', worker, gstreamer], { encoding: 'utf8' }),
  );
  const run = spawnSync(launcher, ['--launch', profile, '--', worker, '--self-check', 'net'], {
    encoding: 'utf8',
    env: { ...gstEnv, GST_REGISTRY_UPDATE: 'no' },
    cwd: '/',
  });
  result.mediaNet = lastJson(`${run.stdout}`);
  if (!result.mediaNet.ok) result.mediaNet.stderr = run.stderr.slice(-400);
}

result.ok = Boolean(
  result.serverNode.ok && result.relay.ok && result.worker.ok && result.mediaNet.ok,
);
console.log(JSON.stringify(result, null, 2));
