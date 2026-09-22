// Opt-in hardware check for the portable CLI ZIP. Extracts it outside the checkout into a path
// with spaces and non-ASCII characters, then runs it from an unrelated working directory with a
// minimal environment: no SDK or developer paths and a fresh LOCALAPPDATA (so a fresh GStreamer
// registry). Requires the declared prerequisites (Node.js, VC++ runtime) and NVIDIA hardware.
//   node packaging/windows/tests/cli-bundle-check.mjs [zip] [node.exe to run the package with]
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const version = JSON.parse(
  readFileSync(path.join(root, 'apps/server/package.json'), 'utf8'),
).version;
const zip = path.resolve(
  process.argv[2] ||
    path.join(
      root,
      `out/installers/windows-cli/${version}/VidVNC-Server-${version}-windows-x64-unsigned.zip`,
    ),
);
const node = path.resolve(process.argv[3] || process.execPath);
const system = process.env.SystemRoot;
const cmd = path.join(system, 'System32/cmd.exe');
const powershell = path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe');

const scratch = mkdtempSync(path.join(tmpdir(), 'vidvnc-cli-check-'));
const packageRoot = path.join(scratch, 'VidVNC Server Å 測試');
const workingDirectory = path.join(scratch, 'unrelated cwd');
const localAppData = path.join(scratch, 'LocalAppData');
mkdirSync(workingDirectory);
mkdirSync(localAppData);

// What a clean Windows session plus the installed prerequisites provides, and nothing else.
function environment({ withNode = true, extra = {} } = {}) {
  return {
    SystemRoot: system,
    windir: system,
    SystemDrive: process.env.SystemDrive,
    ComSpec: cmd,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    OS: 'Windows_NT',
    PROCESSOR_ARCHITECTURE: process.env.PROCESSOR_ARCHITECTURE,
    NUMBER_OF_PROCESSORS: process.env.NUMBER_OF_PROCESSORS,
    USERPROFILE: process.env.USERPROFILE,
    TEMP: scratch,
    TMP: scratch,
    LOCALAPPDATA: localAppData,
    PATH: [
      path.join(system, 'System32'),
      system,
      path.join(system, 'System32/Wbem'),
      ...(withNode ? [path.dirname(node)] : []),
    ].join(';'),
    // The launcher must neutralize inherited Node.js options.
    NODE_OPTIONS: '--no-such-option',
    ...extra,
  };
}
const launchArguments = (args) => [
  '/d',
  '/s',
  '/c',
  `""${path.join(packageRoot, 'VidVNC.Server.cmd')}" ${args}"`,
];
const launchOptions = { cwd: workingDirectory, windowsHide: true, windowsVerbatimArguments: true };
const launchSync = (args, env = environment()) =>
  spawnSync(cmd, launchArguments(args), { ...launchOptions, env, encoding: 'utf8' });

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

// Test-only, committed fixtures (apps/server/tests/fixtures/tls/README.md); never real
// mkcert or Windows certificate tooling, and never a secret.
const tlsFixture = (name) => path.join(root, 'apps/server/tests/fixtures/tls/valid', name);

function collect(response, resolve) {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => {
    const bytes = Buffer.concat(chunks);
    resolve({
      status: response.statusCode,
      headers: response.headers,
      bytes,
      text: bytes.toString('utf8'),
    });
  });
}
// `rejectUnauthorized: false`: the fixture certificate is self-signed.
function httpsCall(port, requestPath) {
  return new Promise((resolvePromise, reject) => {
    const request = httpsRequest(
      { host: '127.0.0.1', port, path: requestPath, method: 'GET', rejectUnauthorized: false },
      (response) => collect(response, resolvePromise),
    );
    request.on('error', reject);
    request.end();
  });
}
async function waitFor(check, what, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const children = [];
try {
  const quote = (text) => `'${text.replaceAll("'", "''")}'`;
  const expand = spawnSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Expand-Archive -LiteralPath ${quote(zip)} -DestinationPath ${quote(packageRoot)}`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(expand.status, 0, expand.stderr);
  console.log(`Extracted ${zip}\n  to ${packageRoot}\n  running with ${node}`);

  // The enrolment page (Task 12) ships through @vidvnc/web-client's ordinary "files": ["src"]
  // package.json entry, copied by build.mjs's copyTree like every other package file — no
  // separate asset list to maintain. This proves it landed in the real ZIP, not just that the
  // code path exists.
  const webClientSrc = path.join(packageRoot, 'app/node_modules/@vidvnc/web-client/src');
  for (const name of [
    'trust.html',
    'trust.js',
    'trust.css',
    'trust-model.js',
    'trust-instructions.js',
  ])
    assert.ok(existsSync(path.join(webClientSrc, name)), `${name} shipped in the CLI package`);
  console.log('PASS: enrolment page assets present in the unpacked CLI package');

  let result = launchSync('config help');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim(), 'config help prints usage');
  result = launchSync('config no-such-command');
  assert.equal(result.status, 2, `usage errors propagate the server exit code: ${result.stderr}`);
  result = launchSync('config help', environment({ withNode: false }));
  assert.equal(result.status, 1);
  assert.match(result.stderr, /needs Node\.js \d+ or newer/);
  console.log('PASS: config passthrough, exit codes and missing-Node.js message');

  const port = await freePort();
  const tlsPort = await freePort();
  // Same settings path a real server reads (paths.mjs: settingsFiles(dataDirectory()).tls),
  // written before the server starts so it comes up with TLS already configured. `provided`
  // mode with the committed fixture never reaches real mkcert or Windows certificate tooling.
  mkdirSync(path.join(localAppData, 'VidVNC'), { recursive: true });
  writeFileSync(
    path.join(localAppData, 'VidVNC/tls-settings.json'),
    JSON.stringify({
      mode: 'provided',
      port: tlsPort,
      certificatePath: tlsFixture('cert.pem'),
      keyPath: tlsFixture('key.pem'),
      pfxPath: null,
      pfxPassphrase: null,
    }),
  );
  const server = spawn(cmd, launchArguments('--desktop'), {
    ...launchOptions,
    env: environment({ extra: { VIDVNC_HOST: '127.0.0.1', VIDVNC_PORT: String(port) } }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(server);
  let stderr = '';
  server.stderr.on('data', (data) => (stderr += data));
  const exited = new Promise((resolve) => server.once('close', resolve));
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server start timed out: ${stderr}`)), 30000);
    createInterface({ input: server.stdout }).on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message.type === 'ready') resolve(message, clearTimeout(timer));
      } catch {}
    });
    server.once('close', (code) => reject(new Error(`Server exited (${code}): ${stderr}`)));
  });
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<html/i);
  const connect = await fetch(`http://127.0.0.1:${port}/api/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: ready.password }),
  });
  assert.ok(connect.ok, `connect returned ${connect.status}`);

  // The second (TLS) port, wired the same way the first one is: poll until the listener the
  // server started on its own reports itself live, then prove the enrolment page and the
  // trust anchor are actually served correctly on BOTH listeners, not just present as bytes.
  const trustStatus = await waitFor(async () => {
    const body = await (await fetch(`http://127.0.0.1:${port}/api/trust/status`)).json();
    return body.active ? body : null;
  }, 'the TLS listener to report itself active');
  assert.equal(trustStatus.httpsPort, tlsPort);

  const plainTrustPage = await fetch(`http://127.0.0.1:${port}/trust`);
  assert.equal(plainTrustPage.status, 200);
  assert.match(await plainTrustPage.text(), /<html/i);
  const plainAnchor = await fetch(`http://127.0.0.1:${port}/api/trust/anchor`);
  assert.equal(plainAnchor.status, 200);
  assert.equal(plainAnchor.headers.get('content-type'), 'application/x-x509-ca-cert');
  assert.ok((await plainAnchor.arrayBuffer()).byteLength > 0);

  const tlsTrustPage = await httpsCall(tlsPort, '/trust');
  assert.equal(tlsTrustPage.status, 200);
  assert.match(tlsTrustPage.text, /<html/i);
  const tlsAnchor = await httpsCall(tlsPort, '/api/trust/anchor');
  assert.equal(tlsAnchor.status, 200);
  assert.equal(tlsAnchor.headers['content-type'], 'application/x-x509-ca-cert');
  assert.ok(tlsAnchor.bytes.length > 0);
  console.log('PASS: enrolment page and trust anchor served on both the plaintext and TLS ports');

  server.stdin.end('{"type":"stop"}\n');
  assert.equal(await exited, 0, stderr);
  // A successful TLS bind logs exactly one line (tls/listener.mjs); anything else here would
  // be a stray, unexpected message. The optional " — ..." clause is the coverage warning the
  // fixture certificate (SANs: vidvnc-test.invalid, 127.0.0.1, 203.0.113.25) legitimately
  // triggers on real hardware, whose own hostname/LAN address it was never meant to cover.
  assert.match(stderr, /^TLS ready on port \d+ \(strategy: provided\)(?: — .*)?\.\r?\n$/, stderr);
  console.log(
    'PASS: desktop start (worker probe with bundled plugins), web client, connect, clean stop',
  );

  const cache = path.join(localAppData, 'VidVNC/cache');
  assert.ok(
    readdirSync(cache).some((name) => name.startsWith('gstreamer-v1-')),
    'fresh registry cache',
  );
  const runtimeModule = path.join(
    packageRoot,
    'app/node_modules/@vidvnc/media-worker/runtime-manifest.mjs',
  );
  const { loadRuntimeManifest, packagedWorkerEnvironment } = await import(
    pathToFileURL(runtimeModule)
  );
  const runtime = loadRuntimeManifest(path.join(packageRoot, 'runtime.json'));
  const worker = spawn(runtime.worker, ['--self-test'], {
    cwd: workingDirectory,
    env: packagedWorkerEnvironment(runtime, path.join(localAppData, 'VidVNC'), environment()),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  children.push(worker);
  let workerOutput = '';
  worker.stdout.on('data', (data) => (workerOutput += data));
  worker.stderr.on('data', (data) => (workerOutput += data));
  const workerExit = new Promise((resolve) => worker.once('close', resolve));
  // Sample the worker's loaded modules until it exits, in UTF-8 so non-ASCII paths survive.
  const sampler = spawnSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $seen = @{}; while ($p = Get-Process -Id ${worker.pid} -ErrorAction SilentlyContinue) { try { foreach ($m in $p.Modules) { $seen[$m.FileName] = 1 } } catch {}; Start-Sleep -Milliseconds 100 }; $seen.Keys`,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(await workerExit, 0, workerOutput);
  const modules = sampler.stdout.split(/\r?\n/).filter(Boolean);
  const inside = (directory, file) => file.toLowerCase().startsWith(`${directory.toLowerCase()}\\`);
  const foreign = modules.filter((file) => !inside(packageRoot, file) && !inside(system, file));
  assert.deepEqual(foreign, [], 'modules loaded from outside the package and Windows');
  for (const name of ['media-worker.exe', 'gstnvcodec.dll', 'gstd3d11.dll', 'vcruntime140.dll'])
    assert.ok(
      modules.some((file) => path.basename(file).toLowerCase() === name),
      `${name} loaded`,
    );
  const directories = [
    ...new Set(modules.filter((file) => !inside(packageRoot, file)).map(path.dirname)),
  ];
  console.log(
    `PASS: worker self-test captured and encoded; ${modules.length} modules, all from the package or Windows:\n  ${directories.sort().join('\n  ')}`,
  );
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
