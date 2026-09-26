// Explicit Windows acceptance check for prototype gate P3 of
// docs/superpowers/specs/2026-09-26-r4-media-relay-and-privilege-split-design.md: can the
// network process run webrtcbin under the tier T1 sandbox (restricted token with the user SID
// deny-only, low integrity, job, alternate desktop)?
//
// Usage: node sandbox-check.mjs
//
// Builds the worker and sandbox-probe.exe if their sources changed, then runs the probe with
// the worker's environment. The probe prints one PASS, FAIL or INFO line per check.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { executable, workerEnvironment } from '../runtime.mjs';
import { ensureJsDependencies, ensureNativeWorker } from '../../../tools/dependencies.mjs';

ensureJsDependencies();
ensureNativeWorker();

const probe = path.join(path.dirname(executable), 'sandbox-probe.exe');
const run = spawnSync(probe, [], {
  env: workerEnvironment(),
  encoding: 'utf8',
  timeout: 90_000,
  windowsHide: true,
});
if (run.error) throw run.error;
process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
console.log(run.status === 0 ? 'PASS: sandbox check' : `FAIL: sandbox check (exit ${run.status})`);
process.exitCode = run.status === 0 ? 0 : 1;
