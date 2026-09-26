// Explicit Windows acceptance check for prototype gate P3 of
// docs/superpowers/specs/2026-09-26-r4-media-relay-and-privilege-split-design.md: can the
// network process run webrtcbin under the tier T1 sandbox (restricted token with the user SID
// deny-only, low integrity, job, alternate desktop)?
//
// Usage: node sandbox-check.mjs [--diagnose]
//
// Gate P4 follows when the sandbox passes: the probe runs again with Arbitrary Code Guard, then
// Win32k lockdown, then both turned on before the network checks, and the output says what
// breaks. P4 only informs the design, so it does not change the exit code.
//
// Builds the worker and sandbox-probe.exe if their sources changed, then runs the probe with
// the worker's environment. The probe prints one PASS, FAIL or INFO line per check. When the
// full sandbox fails (or with --diagnose), the probe runs again with one part of the sandbox
// turned off at a time, and a table shows which part the failure depends on.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { executable, workerEnvironment } from '../runtime.mjs';
import { ensureJsDependencies, ensureNativeWorker } from '../../../tools/dependencies.mjs';

ensureJsDependencies();
ensureNativeWorker();

const probe = path.join(path.dirname(executable), 'sandbox-probe.exe');
const PARTS = [
  'detached',
  'job',
  'desktop',
  'mitigations',
  'object-security',
  'initial-token',
  'restricted',
];

function run(relaxed, hardening) {
  const args = [
    ...(relaxed ? ['--relax', relaxed] : []),
    ...(hardening ? ['--harden', hardening] : []),
  ];
  const result = spawnSync(probe, args, {
    env: workerEnvironment(),
    encoding: 'utf8',
    timeout: 90_000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  const exit = /^INFO: the probe exited with code (\d+)/m.exec(result.stdout);
  return {
    ...result,
    // The child's first check; absent when it died before its own code ran.
    reached: /^(PASS|FAIL): started impersonating/m.test(result.stdout),
    child: exit ? `0x${Number(exit[1]).toString(16).toUpperCase().padStart(8, '0')}` : 'none',
  };
}

const full = run('');
process.stdout.write(full.stdout);
if (full.stderr) process.stderr.write(full.stderr);
console.log(
  full.status === 0 ? 'PASS: sandbox check' : `FAIL: sandbox check (exit ${full.status})`,
);

if (full.status !== 0 || process.argv.includes('--diagnose')) {
  console.log('\nDiagnosis: the same probe with one part of the sandbox turned off.');
  const rows = [...PARTS.map((part) => [part, run(part)]), [PARTS.join(','), run(PARTS.join(','))]];
  for (const [relaxed, result] of rows)
    console.log(
      `  without ${relaxed.padEnd(16)} child exit ${result.child}, ` +
        `${result.reached ? 'reached the probe code' : 'died before the probe code'}, ` +
        `result ${result.status === 0 ? 'PASS' : 'FAIL'}`,
    );
  for (const [relaxed, result] of rows)
    if (result.status !== 0 && result.reached) {
      console.log(`\nFailing checks without ${relaxed}:`);
      for (const line of result.stdout.split(/\r?\n/))
        if (line.startsWith('FAIL:')) console.log(`  ${line}`);
    }
}
if (full.status === 0) {
  console.log('\nGate P4: the same probe with mitigations turned on after lowering.');
  for (const hardening of ['acg', 'win32k', 'acg,win32k']) {
    const result = run('', hardening);
    const failing = result.stdout.split(/\r?\n/).filter((line) => line.startsWith('FAIL:'));
    const finished = /^RESULT: /m.test(result.stdout);
    console.log(
      `  with ${hardening.padEnd(11)} child exit ${result.child}, ` +
        (result.status === 0
          ? 'every check passes'
          : finished
            ? `${failing.length} check(s) fail`
            : 'the child died before finishing'),
    );
    for (const line of failing) console.log(`    ${line}`);
    if (!finished) {
      const last = result.stdout
        .trim()
        .split(/\r?\n/)
        .filter((line) => !line.startsWith('INFO: the probe exited'));
      console.log(`    last line: ${last.at(-1)}`);
    }
  }
}
process.exitCode = full.status === 0 ? 0 : 1;
