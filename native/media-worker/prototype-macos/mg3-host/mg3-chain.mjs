// MG3 prototype only: the Node.js step of app -> node -> media-worker. Runs the worker's probe
// and reports it with the process ancestry, as JSON.
import { execFileSync, spawnSync } from 'node:child_process';

const ancestry = [];
const seen = new Set();
for (let pid = process.pid; pid > 1 && !seen.has(pid) && ancestry.length < 12; ) {
  seen.add(pid);
  const row = execFileSync('/bin/ps', ['-o', 'pid=,ppid=,comm=', '-p', String(pid)], {
    encoding: 'utf8',
  }).trim();
  const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(row);
  ancestry.push(match ? `${pid} ${match[3]}` : `${pid} ? ${JSON.stringify(row)}`);
  if (!match) break;
  pid = Number(match[2]);
}
const run = spawnSync(process.env.VIDVNC_MEDIA_WORKER, ['--mg3'], { encoding: 'utf8' });
const probe = run.stdout
  .split('\n')
  .filter((line) => line.startsWith('{'))
  .map((line) => JSON.parse(line))[0];
console.log(JSON.stringify({ node: process.execPath, ancestry, probe }, null, 2));
