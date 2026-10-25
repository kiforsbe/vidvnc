// Checks a built macOS package the way a user receives it (plan phase 6):
//   node packaging/macos/tests/package-check.mjs macos-server|macos-cli [file]
// file defaults to this version's DMG or ZIP in out/installers, notarized or not.
// - Signatures: every program verifies with --strict, is Developer ID signed with the
//   hardened runtime and only its own entitlements; for a notarized build, Gatekeeper
//   (spctl) accepts it and the app and DMG carry stapled tickets.
// - Libraries: every Mach-O in the package loads only system libraries and @rpath ones,
//   and its rpaths stay inside the package.
// - Running: copied to a path with spaces and non-ASCII characters and run from an unrelated
//   folder, with a fresh home and hostile Node.js options, `vidvnc` runs `config`, the server
//   starts with the bundled worker and relay and serves the web client, every process maps
//   libraries from the package or the system only, a clean stop exits 0, and after SIGKILL no
//   VidVNC process outlives the server.
// Nothing here needs Screen Recording or Device Control: no viewer connects.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { readMachO } from '../../shared/macho-dependencies.mjs';

const [target, given] = process.argv.slice(2);
if (!['macos-server', 'macos-cli'].includes(target))
  throw new Error(
    'Usage: node packaging/macos/tests/package-check.mjs macos-server|macos-cli [file]',
  );
const server = target === 'macos-server';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const version = JSON.parse(
  readFileSync(path.join(root, 'apps/server/package.json'), 'utf8'),
).version;
const installers = path.join(root, 'out/installers', target, version);
const base = server ? `VidVNC-${version}-macos-arm64` : `VidVNC-CLI-${version}-macos-arm64`;
const extension = server ? '.dmg' : '.zip';
const file = path.resolve(
  given ??
    [`${base}${extension}`, `${base}-not-notarized${extension}`]
      .map((name) => path.join(installers, name))
      .find(existsSync) ??
    path.join(installers, `${base}${extension}`),
);
assert.ok(
  existsSync(file),
  `No package at ${file}; build it with packaging/macos/build.mjs ${target}`,
);
const notarized = !file.includes('-not-notarized');

const tool = (command, args, options = {}) =>
  spawnSync(command, args, { encoding: 'utf8', ...options });
const ok = (command, args, what) => {
  const result = tool(command, args);
  assert.equal(result.status, 0, `${what}: ${result.stderr}${result.stdout}`);
  return `${result.stdout}${result.stderr}`;
};
const pass = (message) => console.log(`PASS: ${message}`);

// realpath: macOS tmpdir() is under /var, a link to /private/var.
const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), 'vidvnc-package-check-')));
const place = path.join(scratch, 'Vid VNC Prüfung 測試');
const home = path.join(scratch, 'home');
const unrelated = path.join(scratch, 'unrelated cwd');
for (const directory of [place, home, unrelated]) mkdirSync(directory);
const children = [];
let mounted = null;
try {
  // 1. Unpack as a user would.
  let top;
  if (server) {
    if (notarized) {
      ok('/usr/bin/xcrun', ['stapler', 'validate', file], 'the DMG has a stapled ticket');
      ok(
        '/usr/sbin/spctl',
        ['--assess', '--type', 'open', '--context', 'context:primary-signature', '-v', file],
        'Gatekeeper accepts the DMG',
      );
    }
    ok('/usr/bin/codesign', ['--verify', '--strict', file], 'the DMG signature');
    mounted = path.join(scratch, 'volume');
    ok(
      '/usr/bin/hdiutil',
      ['attach', '-nobrowse', '-readonly', '-mountpoint', mounted, file],
      'mount the DMG',
    );
    assert.equal(lstatSync(path.join(mounted, 'Applications')).isSymbolicLink(), true);
    ok(
      '/usr/bin/ditto',
      [path.join(mounted, 'VidVNC.app'), path.join(place, 'VidVNC.app')],
      'copy the app',
    );
    ok('/usr/bin/hdiutil', ['detach', mounted], 'unmount the DMG');
    mounted = null;
    top = path.join(place, 'VidVNC.app');
  } else {
    ok('/usr/bin/ditto', ['-x', '-k', file, place], 'unpack the ZIP');
    top = path.join(place, base);
  }
  pass(`unpacked ${path.basename(file)} into ${place}`);

  // 2. Signatures.
  const contents = server ? path.join(top, 'Contents') : top;
  const programs = server
    ? {
        app: { path: top, entitlements: [] },
        server: {
          path: path.join(contents, 'MacOS/VidVNC Server'),
          entitlements: ['com.apple.security.cs.allow-jit'],
        },
        launcher: { path: path.join(contents, 'Helpers/vidvnc'), entitlements: [] },
        helper: { path: path.join(contents, 'Helpers/VidVNC Capture.app'), entitlements: [] },
      }
    : {
        server: {
          path: path.join(contents, 'runtime/VidVNC Server'),
          entitlements: ['com.apple.security.cs.allow-jit'],
        },
        launcher: { path: path.join(contents, 'vidvnc'), entitlements: [] },
        helper: { path: path.join(contents, 'runtime/VidVNC Capture.app'), entitlements: [] },
      };
  const managed = /^com\.apple\.(application-identifier|developer\.)/;
  for (const [name, program] of Object.entries(programs)) {
    ok('/usr/bin/codesign', ['--verify', '--deep', '--strict', program.path], `${name} signature`);
    const details = ok(
      '/usr/bin/codesign',
      ['-dv', '--verbose=4', program.path],
      `${name} details`,
    );
    assert.match(
      details,
      /^Authority=Developer ID Application: /m,
      `${name} is Developer ID signed`,
    );
    assert.match(details, /flags=0x10000\(runtime\)/, `${name} has the hardened runtime`);
    assert.match(details, /^Timestamp=/m, `${name} has a secure timestamp`);
    const plist = tool('/usr/bin/codesign', [
      '-d',
      '--entitlements',
      '-',
      '--xml',
      program.path,
    ]).stdout;
    const keys = [...plist.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
    assert.deepEqual(
      keys.filter((key) => !managed.test(key)),
      program.entitlements,
      `${name} has only its own entitlements`,
    );
  }
  if (notarized) {
    // The CLI's bare programs cannot carry a ticket and Gatekeeper assesses only bundles,
    // so its capture helper stands in: Gatekeeper finds its notarization online.
    if (server) ok('/usr/bin/xcrun', ['stapler', 'validate', top], 'the app has a stapled ticket');
    const bundle = server ? top : programs.helper.path;
    const assessment = ok(
      '/usr/sbin/spctl',
      ['--assess', '--type', 'execute', '-v', bundle],
      `Gatekeeper accepts ${path.basename(bundle)}`,
    );
    assert.match(assessment, /source=Notarized Developer ID/);
  }
  pass(
    `signatures${notarized ? ', notarization and Gatekeeper' : ' (not notarized: Gatekeeper not checked)'}`,
  );

  // 3. Every Mach-O loads only the system's libraries and its own.
  const images = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const head = Buffer.alloc(4);
        const bytes = readFileSync(full);
        bytes.copy(head, 0, 0, 4);
        if ([0xcffaedfe, 0xcafebabe].includes(head.readUInt32BE(0))) images.push({ full, bytes });
      }
    }
  };
  walk(contents);
  for (const { full, bytes } of images) {
    const image = readMachO(bytes);
    const relative = path.relative(contents, full);
    for (const library of image.libraries)
      assert.match(
        library,
        /^(\/usr\/lib\/|\/System\/Library\/|@rpath\/[^/]+$)/,
        `${relative} loads ${library}`,
      );
    for (const rpath of image.rpaths)
      assert.match(rpath, /^@(loader|executable)_path(\/|$)/, `${relative} has rpath ${rpath}`);
    assert.equal(
      tool('/usr/bin/lipo', ['-archs', full]).stdout.trim(),
      'arm64',
      `${relative} is arm64 only`,
    );
  }
  pass(`${images.length} Mach-O images load only system and @rpath libraries`);

  // 4. Run it.
  const launcher = programs.launcher.path;
  const environment = (extra = {}) => ({
    HOME: home,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: `${scratch}/`,
    // The launcher must clear inherited Node.js options.
    NODE_OPTIONS: '--no-such-option',
    NODE_PATH: unrelated,
    ...extra,
  });
  const launch = (args, extra) => tool(launcher, args, { cwd: unrelated, env: environment(extra) });
  let result = launch(['config', 'help']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim(), 'config help prints usage');
  result = launch(['config', 'no-such-command']);
  assert.equal(result.status, 2, `usage errors keep the server's exit code: ${result.stderr}`);
  pass('vidvnc config passes arguments and exit codes through');

  const freePort = async (udp = false) => {
    if (udp) {
      const { createSocket } = await import('node:dgram');
      const socket = createSocket('udp4');
      await new Promise((resolve) => socket.bind(0, '127.0.0.1', resolve));
      const { port } = socket.address();
      socket.close();
      return port;
    }
    const listener = createServer();
    await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const { port } = listener.address();
    await new Promise((resolve) => listener.close(resolve));
    return port;
  };
  result = launch(['config', 'media-port', String(await freePort(true))]);
  assert.equal(result.status, 0, result.stderr);

  // The server and every process under it.
  const tree = (pid) => {
    const below = tool('/usr/bin/pgrep', ['-P', String(pid)])
      .stdout.split('\n')
      .filter(Boolean)
      .map(Number);
    return [pid, ...below.flatMap(tree)];
  };
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  async function start() {
    const port = await freePort();
    const child = spawn(launcher, ['--desktop'], {
      cwd: unrelated,
      env: environment({ VIDVNC_HOST: '127.0.0.1', VIDVNC_PORT: String(port) }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (data) => (stderr += data));
    const exited = new Promise((resolve) => child.once('close', resolve));
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Server start timed out: ${stderr}`)), 60000);
      createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          const message = JSON.parse(line);
          if (message.type === 'ready') resolve(message, clearTimeout(timer));
        } catch {}
      });
      child.once('close', (code) => reject(new Error(`Server exited (${code}): ${stderr}`)));
    });
    return { child, port, ready, exited, stderr: () => stderr };
  }

  const first = await start();
  const page = await fetch(`http://127.0.0.1:${first.port}/`, { redirect: 'manual' });
  assert.ok([200, 307].includes(page.status), `web client returned ${page.status}`);
  const processes = tree(first.child.pid);
  for (const pid of processes) {
    const program = tool('/bin/ps', ['-o', 'comm=', '-p', String(pid)]).stdout.trim();
    // ps and lsof escape the non-ASCII folder, so containment is checked against the ASCII
    // scratch folder above it.
    assert.ok(program.startsWith(scratch), `process ${pid} runs ${program}, outside the package`);
  }
  assert.ok(processes.length >= 2, `the server and its relay run: ${processes}`);
  const foreign = new Set();
  for (const pid of processes)
    for (const line of tool('/usr/sbin/lsof', ['-Fn', '-p', String(pid)]).stdout.split('\n'))
      if (/^n\/.*\.dylib$/.test(line) || /^n\/.*\/(node|media-worker|VidVNC Server)$/.test(line)) {
        const mapped = line.slice(1);
        if (!mapped.startsWith(scratch) && !/^\/(usr\/lib|System)\//.test(mapped))
          foreign.add(mapped);
      }
  assert.deepEqual([...foreign], [], 'libraries mapped from outside the package and the system');
  first.child.stdin.end('{"type":"stop"}\n');
  assert.equal(await first.exited, 0, first.stderr());
  pass(`server ready with ${processes.length} packaged processes, web client served, clean stop`);

  const second = await start();
  const started = tree(second.child.pid);
  second.child.kill('SIGKILL');
  await second.exited;
  const deadline = Date.now() + 10000;
  let survivors = started.filter(alive);
  while (survivors.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    survivors = started.filter(alive);
  }
  assert.deepEqual(survivors, [], 'no VidVNC process outlives a killed server');
  pass('after SIGKILL every VidVNC process exits');
} finally {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  if (mounted) tool('/usr/bin/hdiutil', ['detach', '-force', mounted]);
  rmSync(scratch, { recursive: true, force: true });
}
