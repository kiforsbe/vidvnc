// MG4+ prototype only: run by the MG3 host app's bundled Node (through mg3-chain.mjs), so the
// gates run as app -> node -> probe with the app's Screen Recording and Accessibility grants.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// MG_TASK (passed with `open --env MG_TASK=...`) picks another gate's script.
if (process.env.MG_TASK) {
  await import(path.join(here, `${process.env.MG_TASK}.mjs`));
  process.exit(0);
}
const run = spawnSync(path.join(here, 'build-xcode/Release/mg4-probe'), ['--run-all'], {
  encoding: 'utf8',
  maxBuffer: 16 << 20,
});
const lines = `${run.stdout}${run.stderr}`
  .split('\n')
  .filter((line) => /^(PASS|FAIL|INFO|RESULT|===)/.test(line) || line === '');
console.log(lines.join('\n'));
