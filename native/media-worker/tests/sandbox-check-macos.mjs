// Explicit macOS check for media-net's sandbox (design D3 of
// docs/superpowers/specs/2026-10-09-macos-support-design.md, gate MG4). Run through
// sandbox-check.mjs.
//
// Builds the worker and sandbox-probe if their sources changed, then runs the probe twice with
// the worker's environment: without the profile, where the system services behind VidVNC's
// Screen Recording and Accessibility grants must be reachable (so the check can see them), and
// under exactly the profile the launcher gives media-net, where every check must pass: no
// Mach service, no capture, no posting, no reading the owner's files or VidVNC's data, no
// writes, no fork or exec, loopback UDP only, no TCP. The probe also shows the accepted
// residual (a bind on every address) and that the worker's socket audit sees it. WebRTC under
// the same profile is media-net-posix.test.mjs, which npm test runs on a Mac.
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { executable, workerEnvironment } from '../runtime.mjs';
import { dataDirectory } from '../runtime-paths.mjs';
import { ensureJsDependencies, ensureNativeWorker } from '../../../tools/dependencies.mjs';

ensureJsDependencies();
ensureNativeWorker();

const probe = path.join(path.dirname(executable), 'sandbox-probe');
const folder = dataDirectory();
const secret = path.join(folder, 'sandbox-probe-secret.txt');
mkdirSync(folder, { recursive: true });
writeFileSync(secret, 'secret');

function run(args) {
  const result = spawnSync(probe, args, {
    env: workerEnvironment(),
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  return result;
}

let failures = 0;
try {
  console.log('Without the profile:');
  const baseline = run(['--baseline', secret]);
  process.stdout.write(baseline.stdout);
  for (const service of ['com.apple.windowserver.active', 'com.apple.replayd', 'com.apple.tccd']) {
    const seen = baseline.stdout.includes(`mach-lookup ${service} - reachable`);
    if (!seen) failures++;
    console.log(
      `${seen ? 'PASS' : 'FAIL'}: ${service} is reachable without the profile` +
        (seen ? '' : ' (the probe cannot tell the profile denies it)'),
    );
  }
  console.log('\nUnder the media-net profile:');
  const sandboxed = run([secret]);
  process.stdout.write(sandboxed.stdout);
  if (sandboxed.stderr.trim()) console.log(`INFO: probe stderr: ${sandboxed.stderr.trim()}`);
  if (sandboxed.status !== 0) failures++;
} finally {
  rmSync(secret, { force: true });
}
console.log(failures ? 'FAIL: sandbox check' : 'PASS: sandbox check');
process.exitCode = failures ? 1 : 0;
