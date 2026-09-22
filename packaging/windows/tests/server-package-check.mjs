// Opt-in hardware check for the VidVNC MSIX (self-signed development build).
//   node packaging/windows/tests/server-package-check.mjs [msix] [--register]
// Without --register nothing is installed: the MSIX is unpacked with the project's MakeAppx,
// every file is checked against files.json and the signer against the development certificate.
// The unpacked host then runs unpackaged (Windows App Runtime bootstrapper) from a path with
// spaces and non-ASCII characters, an unrelated working directory and a fresh LOCALAPPDATA,
// starts its server with the installed Node.js (or the bundled one, when the package has it) and
// is closed again.
// --register also registers the layout with Add-AppxPackage -Register (Developer Mode), starts
// it through its package identity, checks identity and unvirtualized settings, closes it and
// removes the registration. That run uses the real %LOCALAPPDATA%\VidVNC and port 4382.
// Requires the declared prerequisites and NVIDIA hardware.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
const inputs = readJson(path.join(root, 'packaging/windows/inputs.json'));
const version = readJson(path.join(root, 'apps/server/package.json')).version;
const args = process.argv.slice(2);
const register = args.includes('--register');
const msixFile = path.resolve(
  args.find((arg) => arg !== '--register') ||
    path.join(
      root,
      `out/installers/windows-server/${version}/VidVNC-${version}-windows-x64-selfsigned.msix`,
    ),
);
const certificate = path.join(root, inputs.msix.certificate.replace(/\.pfx$/i, '.cer'));
const system = process.env.SystemRoot;
const powershell = path.join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe');
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const inside = (directory, file) =>
  file.toLowerCase().startsWith(`${directory.toLowerCase().replace(/\\$/, '')}\\`);

// Windows PowerShell with UTF-8 output; values arrive through environment variables, never quoting.
// PSModulePath is dropped: one inherited from PowerShell 7 stops 5.1 loading its own modules.
function ps(script, env = {}) {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'),
  );
  const result = spawnSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; ${script}`,
    ],
    { encoding: 'utf8', windowsHide: true, env: { ...inherited, ...env } },
  );
  assert.equal(result.status, 0, `PowerShell failed: ${result.stderr}`);
  return result.stdout.trim();
}
// ConvertTo-Json writes a lone match as an object, not an array.
const processes = (filter) =>
  [].concat(
    JSON.parse(
      ps(
        `@(Get-CimInstance Win32_Process -Filter $env:FILTER | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine) | ConvertTo-Json -Compress`,
        { FILTER: filter },
      ) || '[]',
    ),
  );
async function waitFor(check, what, timeout = 90000) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await delay(500);
  }
}
async function responds(url) {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(2000) })).ok;
  } catch {
    return false;
  }
}
async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const portInUse = (port) =>
  new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('connect', () => resolve(true, socket.destroy()));
    socket.once('error', () => resolve(false));
  });

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
function httpsCall(port, requestPath, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolvePromise, reject) => {
    const request = httpsRequest(
      { host: '127.0.0.1', port, path: requestPath, method, headers, rejectUnauthorized: false },
      (response) => collect(response, resolvePromise),
    );
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

// A path outside PLAINTEXT_ALLOWED_PATHS redirects to the TLS port the instant TLS is
// active — correct behaviour, not a bug — so a plaintext content check must not assume
// which state it will observe. Ask directly: on a manual-redirect fetch, a 307 back to the
// TLS port means the redirect fired correctly, so verify the real content over TLS via
// httpsCall (which explicitly trusts the fixture); relying on default fetch() to follow
// the redirect would instead depend on whatever this machine's certificate store happens
// to trust, which a clean machine will not.
async function fetchAcrossRedirect(url, tlsPort, init = {}) {
  const response = await fetch(url, { ...init, redirect: 'manual' });
  if (response.status !== 307) return { status: response.status, text: await response.text() };
  const { pathname } = new URL(url);
  return httpsCall(tlsPort, pathname, init);
}

// Closes the host window the way a user does, then checks its server and worker are gone.
async function closeHost(hostPid, root) {
  const children = processes(`ParentProcessId=${hostPid}`);
  ps(`[void](Get-Process -Id $env:HOST_PID).CloseMainWindow()`, { HOST_PID: String(hostPid) });
  await waitFor(() => processes(`ProcessId=${hostPid}`).length === 0, 'the host to exit', 20000);
  await waitFor(
    () => children.every((child) => processes(`ProcessId=${child.ProcessId}`).length === 0),
    'the server to exit',
    10000,
  );
  const leftovers = processes(
    "Name='media-worker.exe' OR Name='VidVnc.Host.exe' OR Name='node.exe'",
  ).filter((item) => item.ExecutablePath && inside(root, item.ExecutablePath));
  assert.deepEqual(leftovers, [], 'package processes left running');
}

const makeappx = (() => {
  const assets = readJson(
    path.join(root, path.dirname(inputs.host.project), 'obj/project.assets.json'),
  );
  const key = Object.keys(assets.libraries).find((name) =>
    name.startsWith('Microsoft.Windows.SDK.BuildTools/'),
  );
  const bin = path.join(Object.keys(assets.packageFolders)[0], assets.libraries[key].path, 'bin');
  return readdirSync(bin)
    .map((sdk) => path.join(bin, sdk, 'x64/makeappx.exe'))
    .find(existsSync);
})();

const scratch = mkdtempSync(path.join(tmpdir(), 'vidvnc-server-check-'));
const unpacked = path.join(scratch, 'VidVNC Å 測試');
const workingDirectory = path.join(scratch, 'unrelated cwd');
const localAppData = path.join(scratch, 'LocalAppData');
mkdirSync(workingDirectory);
mkdirSync(localAppData);
const started = [];
let registered;
try {
  // 1. Contents and signature, without installing.
  const unpack = spawnSync(makeappx, ['unpack', '/o', '/p', msixFile, '/d', unpacked], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(unpack.status, 0, unpack.stdout + unpack.stderr);
  const inventory = readJson(path.join(unpacked, 'files.json'));
  const expected = new Map(
    inventory.files.map((file) => [file.path.replaceAll('/', '\\').toLowerCase(), file]),
  );
  const packagingFiles = [
    'files.json',
    'appxblockmap.xml',
    'appxsignature.p7x',
    '[content_types].xml',
    'appxmetadata\\codeintegrity.cat',
  ];
  const found = readdirSync(unpacked, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(unpacked, path.join(entry.parentPath, entry.name)));
  for (const relative of found) {
    const record = expected.get(relative.toLowerCase());
    if (!record) {
      assert.ok(packagingFiles.includes(relative.toLowerCase()), `unexpected file ${relative}`);
      continue;
    }
    const file = path.join(unpacked, relative);
    assert.equal(statSync(file).size, record.size, `${relative} size`);
    assert.equal(sha256(file), record.sha256, `${relative} hash`);
    expected.delete(relative.toLowerCase());
  }
  assert.deepEqual(
    [...expected.keys()],
    [],
    'files listed in files.json but missing from the MSIX',
  );
  const signature = JSON.parse(
    ps(
      `$s = Get-AuthenticodeSignature -LiteralPath $env:MSIX; $c = [Security.Cryptography.X509Certificates.X509Certificate2]::new($env:CER); @{ status = [string]$s.Status; message = $s.StatusMessage; signer = $s.SignerCertificate.Thumbprint; expected = $c.Thumbprint; subject = $c.Subject } | ConvertTo-Json -Compress`,
      { MSIX: msixFile, CER: certificate },
    ),
  );
  assert.equal(signature.signer, signature.expected, 'signed with the development certificate');
  assert.ok(
    ['Valid', 'UnknownError', 'NotTrusted'].includes(signature.status),
    `signature ${signature.status}: ${signature.message}`,
  );
  const manifest = readFileSync(path.join(unpacked, 'AppxManifest.xml'), 'utf8');
  assert.equal(/<Identity [^>]*Publisher="([^"]+)"/.exec(manifest)[1], signature.subject);
  console.log(
    `PASS: ${found.length} files match files.json; signed by ${signature.subject} (${signature.status}: ${signature.message})`,
  );

  // The enrolment page (Task 12) ships through @vidvnc/web-client's ordinary "files": ["src"]
  // package.json entry, copied by build.mjs's copyTree like every other package file — no
  // separate asset list to maintain. This proves it landed in the real MSIX, not just that
  // the code path exists. Proven from the unpacked, unregistered layout (ruling: this check
  // never runs with --register).
  const webClientSrc = path.join(unpacked, 'app/node_modules/@vidvnc/web-client/src');
  for (const name of [
    'trust.html',
    'trust.js',
    'trust.css',
    'trust-model.js',
    'trust-instructions.js',
  ])
    assert.ok(existsSync(path.join(webClientSrc, name)), `${name} shipped in the MSIX package`);
  console.log('PASS: enrolment page assets present in the unpacked MSIX');

  // 2. The unpacked host, not installed, relocated with a minimal environment. Installed Node.js
  // stays on PATH; a package that bundles Node.js must still run its own.
  const bundledNode = readJson(path.join(unpacked, 'runtime.json')).node;
  const nodeKind = bundledNode ? 'bundled' : 'installed';
  const node = bundledNode ? path.join(unpacked, bundledNode) : process.execPath;
  const port = await freePort();
  const tlsPort = await freePort();
  // Same settings path a real server reads (paths.mjs: settingsFiles(dataDirectory()).tls),
  // written before the host starts so its server comes up with TLS already configured.
  // `provided` mode with the committed fixture never reaches real mkcert or Windows
  // certificate tooling.
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
  const env = {
    ...Object.fromEntries(
      [
        'SystemRoot',
        'windir',
        'SystemDrive',
        'ComSpec',
        'PATHEXT',
        'OS',
        'PROCESSOR_ARCHITECTURE',
        'NUMBER_OF_PROCESSORS',
        'USERPROFILE',
        'USERNAME',
        'USERDOMAIN',
        'COMPUTERNAME',
        'APPDATA',
        'HOMEDRIVE',
        'HOMEPATH',
        'ProgramData',
        'ProgramFiles',
        'ProgramFiles(x86)',
        'ProgramW6432',
        'CommonProgramFiles',
        'PUBLIC',
        'ALLUSERSPROFILE',
      ]
        .filter((key) => process.env[key] !== undefined)
        .map((key) => [key, process.env[key]]),
    ),
    TEMP: scratch,
    TMP: scratch,
    LOCALAPPDATA: localAppData,
    PATH: [path.join(system, 'System32'), system, path.dirname(process.execPath)].join(';'),
    // A packaged launch must ignore developer overrides.
    NODE_OPTIONS: '--no-such-option',
    GST_PLUGIN_PATH_1_0: path.join(scratch, 'no-plugins'),
    VIDVNC_MEDIA_WORKER: path.join(scratch, 'no-worker.exe'),
    VIDVNC_HOST: '127.0.0.1',
    VIDVNC_PORT: String(port),
  };
  const host = spawn(path.join(unpacked, inputs.host.executable), [], {
    cwd: workingDirectory,
    env,
    stdio: 'ignore',
  });
  started.push(host.pid);
  const hostExit = new Promise((resolve) => host.once('exit', resolve));
  await Promise.race([
    // Probed on an allow-listed path: this gate can fire at any point in the startup
    // sequence, including after TLS binds, and /api/trust/status never redirects, so
    // readiness is never confused with a redirect `responds()` cannot follow.
    waitFor(
      () => responds(`http://127.0.0.1:${port}/api/trust/status`),
      'the server (worker probe passed)',
    ),
    hostExit.then((code) => {
      throw new Error(`The host exited (${code}) before its server was ready`);
    }),
  ]);
  const page = await fetchAcrossRedirect(`http://127.0.0.1:${port}/`, tlsPort);
  assert.match(page.text, /<html/i);

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

  const [server] = processes(`ParentProcessId=${host.pid} AND Name='node.exe'`);
  assert.ok(server, 'the host started a Node.js server');
  assert.equal(
    server.ExecutablePath.toLowerCase(),
    node.toLowerCase(),
    `server runs on the ${nodeKind} Node.js`,
  );
  assert.ok(
    server.CommandLine.includes(path.join(unpacked, 'app')),
    'server runs from the package',
  );
  assert.ok(
    readdirSync(path.join(localAppData, 'VidVNC/cache')).some((name) =>
      name.startsWith('gstreamer-v1-'),
    ),
    'fresh registry cache in the given LOCALAPPDATA',
  );
  await closeHost(host.pid, unpacked);
  console.log(
    `PASS: unpackaged host from ${unpacked} started its server on ${nodeKind} Node.js, served the web client and closed cleanly`,
  );

  // 3. Registered through its package identity (installs on this machine).
  if (register) {
    assert.equal(
      ps(`@(Get-AppxPackage -Name $env:NAME).Count`, { NAME: inputs.msix.name }),
      '0',
      'VidVNC is already installed; not touching it',
    );
    assert.equal(
      await portInUse(4382),
      false,
      'port 4382 is in use; stop the other VidVNC server first',
    );
    const layout = path.join(scratch, 'registered layout Å');
    cpSync(unpacked, layout, {
      recursive: true,
      filter: (source) =>
        !['appxsignature.p7x', 'appxblockmap.xml', '[content_types].xml', 'appxmetadata'].includes(
          path.basename(source).toLowerCase(),
        ),
    });
    ps(`Add-AppxPackage -Register -Path (Join-Path $env:LAYOUT 'AppxManifest.xml')`, {
      LAYOUT: layout,
    });
    registered = JSON.parse(
      ps(
        `Get-AppxPackage -Name $env:NAME | Select-Object PackageFullName, PackageFamilyName, InstallLocation | ConvertTo-Json -Compress`,
        { NAME: inputs.msix.name },
      ),
    );
    const launched = Date.now();
    ps(`Start-Process ('shell:AppsFolder\\' + $env:PFN + '!App')`, {
      PFN: registered.PackageFamilyName,
    });
    const hostProcess = await waitFor(
      () =>
        processes(`Name='${inputs.host.executable}'`).find(
          (item) => item.ExecutablePath && inside(layout, item.ExecutablePath),
        ),
      'the registered host to start',
      30000,
    );
    started.push(hostProcess.ProcessId);
    await waitFor(
      // Allow-listed, for the same reason as the gate above: the registered package runs
      // against the real user profile, so this machine may well have TLS configured.
      () => responds('http://127.0.0.1:4382/api/trust/status'),
      'the registered server (worker probe passed)',
    );
    const [registeredServer] = processes(
      `ParentProcessId=${hostProcess.ProcessId} AND Name='node.exe'`,
    );
    assert.ok(registeredServer, 'the registered host started a Node.js server');
    const identities = JSON.parse(
      ps(
        `Add-Type -Namespace VidVnc -Name Identity -MemberDefinition @'
[DllImport("kernel32.dll")] static extern System.IntPtr OpenProcess(uint access, bool inherit, int id);
[DllImport("kernel32.dll")] static extern bool CloseHandle(System.IntPtr handle);
[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern int GetPackageFullName(System.IntPtr process, ref int length, System.Text.StringBuilder name);
public static string Of(int id) { var h = OpenProcess(0x1000, false, id); try { int n = 256; var b = new System.Text.StringBuilder(n); return GetPackageFullName(h, ref n, b) == 0 ? b.ToString() : ""; } finally { CloseHandle(h); } }
'@
@{ host = [VidVnc.Identity]::Of([int]$env:HOST_PID); server = [VidVnc.Identity]::Of([int]$env:SERVER_PID) } | ConvertTo-Json -Compress`,
        { HOST_PID: String(hostProcess.ProcessId), SERVER_PID: String(registeredServer.ProcessId) },
      ),
    );
    assert.equal(identities.host, registered.PackageFullName, 'host runs with package identity');
    const userData = path.join(process.env.LOCALAPPDATA, 'VidVNC');
    const identity = createHash('sha256').update(realpathSync(layout)).digest('hex').slice(0, 16);
    const cache = path.join(userData, 'cache', `gstreamer-v1-${identity}.bin`);
    assert.ok(
      existsSync(cache) && statSync(cache).mtimeMs >= launched - 2000,
      `registry cache written to the real ${cache}`,
    );
    const virtualized = path.join(
      process.env.LOCALAPPDATA,
      'Packages',
      registered.PackageFamilyName,
      'LocalCache/Local/VidVNC',
    );
    assert.equal(existsSync(virtualized), false, 'no virtualized copy of VidVNC data');
    await closeHost(hostProcess.ProcessId, layout);
    ps(`Remove-AppxPackage -Package $env:FULL`, { FULL: registered.PackageFullName });
    assert.equal(ps(`@(Get-AppxPackage -Name $env:NAME).Count`, { NAME: inputs.msix.name }), '0');
    registered = null;
    assert.ok(existsSync(userData), 'settings folder kept after removal');
    rmSync(cache, { force: true }); // this run's registry cache for the temporary layout
    console.log(
      `PASS: registered package started via its identity (host ${identities.host}; server ${identities.server || 'no identity'}), wrote settings unvirtualized to ${userData}, closed cleanly and was removed`,
    );
  }
} finally {
  if (registered) ps(`Remove-AppxPackage -Package $env:FULL`, { FULL: registered.PackageFullName });
  for (const pid of started)
    spawnSync(path.join(system, 'System32/taskkill.exe'), ['/pid', String(pid), '/t', '/f'], {
      stdio: 'ignore',
    });
  // Killed processes release their image and working directory a little later; never mask a failure.
  try {
    await waitFor(
      () => processes(`ExecutablePath LIKE '${scratch.replaceAll('\\', '\\\\')}%'`).length === 0,
      'package processes to exit',
      15000,
    );
    rmSync(scratch, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (error) {
    console.warn(`Could not remove ${scratch}: ${error.message}`);
  }
}
